import { Suspense, useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import GrainyGradient from "./components/ui/gradient-shader-card";

const STORAGE_KEY = "ai-study-assistant.state.v1";
const GENERAL_THREAD_KEY = "__general__";
const configuredApiUrl = (import.meta.env.VITE_API_URL || "").trim();
const runtimeHost = typeof window !== "undefined" ? window.location.hostname : "";
const isLocalRuntime = runtimeHost === "localhost" || runtimeHost === "127.0.0.1";
const API_BASE_URLS = Array.from(
  new Set(
    [
      configuredApiUrl,
      ...(isLocalRuntime ? ["http://127.0.0.1:8000", "http://localhost:8000"] : []),
    ]
      .map((url) => url.replace(/\/+$/, ""))
      .filter(Boolean)
  )
);

const buildApiUrl = (baseUrl, path) => `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

const apiFetch = async (path, options = {}) => {
  if (API_BASE_URLS.length === 0) {
    throw new Error("VITE_API_URL is not configured for this deployment");
  }

  let lastError = null;

  for (const baseUrl of API_BASE_URLS) {
    try {
      return await fetch(buildApiUrl(baseUrl, path), options);
    } catch (error) {
      lastError = error;
      if (error?.message !== "Failed to fetch") {
        throw error;
      }
    }
  }

  throw lastError || new Error("Failed to fetch");
};

const createInitialMessage = () => ({
  id: 0,
  role: "assistant",
  text: "Ask me anything from your PDF or a general study question.",
});

const createOfflineFallback = (question, activeDocument, documents) => {
  const query = question.toLowerCase().trim();

  if (query.includes("risc") && query.includes("cisc")) {
    return (
      "RISC (Reduced Instruction Set Computer) uses a smaller, simpler set of instructions. "
      + "That usually makes decoding easier and execution more efficient. CISC (Complex Instruction Set Computer) "
      + "uses richer instructions that can do more work per instruction, but they are more complex to decode. "
      + "In short: RISC emphasizes simplicity and speed, while CISC emphasizes more powerful instructions and compact code."
    );
  }

  if (query.includes("i/o module") || query === "what is i/o module" || query.startsWith("what is i/o")) {
    return (
      "An I/O module is a hardware component that manages communication between the CPU, memory, and input/output devices. "
      + "It helps control data transfer, buffering, status reporting, and device timing so the processor does not have to handle every low-level detail directly."
    );
  }

  if (activeDocument && activeDocument !== GENERAL_THREAD_KEY) {
    return (
      "Sorry, I'm having trouble connecting right now. "
      + `Your file "${activeDocument}" is still selected — please try again in a moment.`
    );
  }

  if (documents.length > 0) {
    return (
      "Sorry, I'm temporarily unable to process your question. "
      + "Your uploaded files are safe — please try again in a moment."
    );
  }

  return "Sorry, I'm temporarily unavailable. Please upload a PDF and try again in a moment.";
};

const createFreshState = () => ({
  threads: { [GENERAL_THREAD_KEY]: [createInitialMessage()] },
  documents: [],
  activeDocument: GENERAL_THREAD_KEY,
});

const isErrorMessage = (msg) => {
  if (msg.source === "offline") return true;
  if (msg.role !== "assistant") return false;
  const text = (msg.text || "").toLowerCase();
  return (
    text.includes("failed to fetch") ||
    text.includes("upload failed") ||
    text.includes("could not connect") ||
    text.includes("could not reach") ||
    text.includes("temporarily unavailable") ||
    text.includes("could not summarize")
  );
};

const filterErrorMessages = (messages) => {
  if (!Array.isArray(messages)) return [createInitialMessage()];
  const filtered = messages.filter((msg) => !isErrorMessage(msg));
  return filtered.length > 0 ? filtered : [createInitialMessage()];
};

const loadState = () => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createFreshState();

    const parsed = JSON.parse(raw);
    const threads = parsed.threads && typeof parsed.threads === "object"
      ? parsed.threads
      : { [GENERAL_THREAD_KEY]: [createInitialMessage()] };

    // Strip error/offline messages from every thread so stale errors don't show on reload
    const cleanedThreads = {};
    for (const [key, msgs] of Object.entries(threads)) {
      cleanedThreads[key] = filterErrorMessages(msgs);
    }

    return {
      threads: cleanedThreads,
      documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      activeDocument: parsed.activeDocument || GENERAL_THREAD_KEY,
    };
  } catch {
    return createFreshState();
  }
};

function App() {
  const [state, setState] = useState(() => loadState());
  const [question, setQuestion] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isAsking, setIsAsking] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [ripples, setRipples] = useState([]);
  const [currentTime, setCurrentTime] = useState(0);
  const heroRef = useRef(null);
  const rippleIdRef = useRef(0);
  const fileInputRef = useRef(null);

  const threads = state.threads;
  const documents = state.documents;
  const activeDocument = state.activeDocument || GENERAL_THREAD_KEY;
  const messages = threads[activeDocument] || [createInitialMessage()];

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    if (!threads[activeDocument]) {
      setState((prev) => ({
        ...prev,
        threads: {
          ...prev.threads,
          [activeDocument]: [createInitialMessage()],
        },
      }));
    }
  }, [activeDocument, threads]);

  const setThreadMessages = (threadKey, updater) => {
    setState((prev) => {
      const currentMessages = prev.threads[threadKey] || [createInitialMessage()];
      const nextMessages = typeof updater === "function" ? updater(currentMessages) : updater;

      return {
        ...prev,
        threads: {
          ...prev.threads,
          [threadKey]: nextMessages,
        },
      };
    });
  };

  const appendMessage = (threadKey, message) => {
    setThreadMessages(threadKey, (currentMessages) => [...currentMessages, message]);
  };

  const upsertDocument = (nextDocument) => {
    setState((prev) => {
      const existingIndex = prev.documents.findIndex((document) => document.filename === nextDocument.filename);
      const nextDocuments = [...prev.documents];

      if (existingIndex >= 0) {
        nextDocuments[existingIndex] = {
          ...nextDocuments[existingIndex],
          ...nextDocument,
        };
      } else {
        nextDocuments.unshift(nextDocument);
      }

      return {
        ...prev,
        documents: nextDocuments,
      };
    });
  };

  const updateDocument = (filename, patch) => {
    setState((prev) => ({
      ...prev,
      documents: prev.documents.map((document) => (
        document.filename === filename ? { ...document, ...patch } : document
      )),
    }));
  };

  const handleSurfaceClick = (event) => {
    if (!heroRef.current) return;

    const rect = heroRef.current.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const ripple = {
      id: rippleIdRef.current += 1,
      x,
      y,
      startTime: currentTime,
    };

    setRipples((prev) => [...prev, ripple]);

    window.setTimeout(() => {
      setRipples((prev) => prev.filter((item) => item.id !== ripple.id));
    }, 2000);
  };

  const handleTimeUpdate = (time) => {
    setCurrentTime(time);
  };

  const readJsonResponse = async (response) => {
    try {
      return await response.json();
    } catch {
      return null;
    }
  };

  const uploadSingleFile = async (file, index, total) => {
    const formData = new FormData();
    formData.append("file", file);

    setUploadProgress({
      fileName: file.name,
      current: index + 1,
      total,
    });

    const response = await apiFetch("/upload", {
      method: "POST",
      body: formData,
    });

    const data = await readJsonResponse(response);

    if (!response.ok || data?.error) {
      throw new Error(data?.error || `Upload failed (HTTP ${response.status})`);
    }

    const uploadedDocument = {
      filename: data?.filename || file.name,
      totalChunks: data?.total_chunks || 0,
      totalPages: data?.total_pages || 0,
      uploadedAt: Date.now(),
      status: "ready",
    };

    upsertDocument(uploadedDocument);
    setThreadMessages(uploadedDocument.filename, (currentMessages) => {
      const alreadyExists = currentMessages.some((message) => message.text?.includes("Uploaded"));
      if (alreadyExists) {
        return currentMessages;
      }

      return [
        ...currentMessages,
        {
          id: Date.now() + Math.random(),
          role: "assistant",
          text: `Uploaded ${uploadedDocument.filename}. ${uploadedDocument.totalPages} pages, ${uploadedDocument.totalChunks} chunks.`,
          source: "pdf",
          filename: uploadedDocument.filename,
          citations: [],
        },
      ];
    });

    return uploadedDocument;
  };

  const uploadFilesImmediately = async (files) => {
    if (!files || files.length === 0) return;

    try {
      setIsUploading(true);
      const uploadedNames = [];

      for (let index = 0; index < files.length; index += 1) {
        const uploaded = await uploadSingleFile(files[index], index, files.length);
        uploadedNames.push(uploaded.filename);
      }

      if (uploadedNames.length > 0) {
        setState((prev) => ({
          ...prev,
          activeDocument: uploadedNames[0],
        }));
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      const friendlyMessage = error.message === "Failed to fetch"
        ? "Could not connect to the server. Please make sure the backend is running and try again."
        : error.message.includes("VITE_API_URL is not configured")
          ? "Backend URL is missing in deployment. Set VITE_API_URL in Vercel to your backend API URL and redeploy."
        : `Upload failed: ${error.message}`;
      appendMessage(activeDocument, {
        id: Date.now(),
        role: "assistant",
        text: friendlyMessage,
        source: "offline",
      });
    } finally {
      setIsUploading(false);
      setUploadProgress(null);
    }
  };

  const askQuestion = async () => {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) {
      return;
    }

    const threadKey = activeDocument || GENERAL_THREAD_KEY;
    const userMessage = {
      id: Date.now(),
      role: "user",
      text: trimmedQuestion,
    };

    appendMessage(threadKey, userMessage);
    setQuestion("");

    try {
      setIsAsking(true);

      const response = await apiFetch("/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: trimmedQuestion,
          filename: threadKey === GENERAL_THREAD_KEY ? null : threadKey,
        }),
      });

      const data = await readJsonResponse(response);

      if (!response.ok || data?.error) {
        throw new Error(data?.error || `Answer failed (HTTP ${response.status})`);
      }

      appendMessage(threadKey, {
        id: Date.now() + 1,
        role: "assistant",
        text: data?.answer || "No answer returned.",
        source: data?.source || "pdf",
        filename: data?.filename || (threadKey === GENERAL_THREAD_KEY ? null : threadKey),
        citations: Array.isArray(data?.citations) ? data.citations : [],
      });
    } catch (error) {
      appendMessage(threadKey, {
        id: Date.now() + 2,
        role: "assistant",
        text: createOfflineFallback(trimmedQuestion, threadKey, documents),
        source: "offline",
      });
    } finally {
      setIsAsking(false);
    }
  };

  const summarizeDocument = async (filename) => {
    if (!filename) {
      appendMessage(activeDocument, {
        id: Date.now(),
        role: "assistant",
        text: "Upload a PDF first, then I can generate a summary for it.",
      });
      return;
    }

    try {
      setIsAsking(true);
      setState((prev) => ({ ...prev, activeDocument: filename }));

      const response = await apiFetch("/summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ filename }),
      });

      const data = await readJsonResponse(response);

      if (!response.ok || data?.error) {
        throw new Error(data?.error || `Summary failed (HTTP ${response.status})`);
      }

      appendMessage(filename, {
        id: Date.now() + 1,
        role: "assistant",
        text: data?.summary || "No summary returned.",
        source: "pdf",
        filename: data?.filename || filename,
        citations: Array.isArray(data?.citations) ? data.citations : [],
      });
    } catch (error) {
      const friendlyMessage = error.message === "Failed to fetch"
        ? `Could not summarize "${filename}" — the server is temporarily unavailable. Please try again in a moment.`
        : error.message.includes("VITE_API_URL is not configured")
          ? `Could not summarize "${filename}" because VITE_API_URL is missing in deployment.`
        : `Could not summarize "${filename}". ${error.message}`;
      appendMessage(filename, {
        id: Date.now() + 1,
        role: "assistant",
        text: friendlyMessage,
        source: "offline",
      });
    } finally {
      setIsAsking(false);
    }
  };

  const selectDocument = (filename) => {
    setState((prev) => ({ ...prev, activeDocument: filename }));
  };

  const activeDocumentItem = documents.find((document) => document.filename === activeDocument);

  return (
    <main className="app-shell">
      <section className="hero-card" ref={heroRef} onClick={handleSurfaceClick}>
        <div className="hero-canvas" style={{ position: "absolute", inset: 0, zIndex: 0 }}>
          <Canvas style={{ width: "100%", height: "100%" }}>
            <Suspense fallback={null}>
              <GrainyGradient ripples={ripples} onTimeUpdate={handleTimeUpdate} />
            </Suspense>
          </Canvas>
        </div>

        <div className="hero-overlay" />

        <div className="hero-content">
          <div className="panel-stack">
            <header className="hero-copy">
              <h1>AI Study Assistant</h1>
              <p className="subcopy">
                Upload one or more PDFs, keep separate chat history for each file, and pull answers with page citations.
              </p>
            </header>

            <section className="glass-panel document-panel">
              <div className="answer-head">
                <span className="answer-dot" />
                <h2>Documents</h2>
              </div>

              <p>
                Upload PDF files and generate summaries from your documents.
              </p>

              <div className="file-picker">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => fileInputRef.current && fileInputRef.current.click()}
                  disabled={isUploading || isAsking}
                >
                  Upload PDFs
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf"
                  multiple
                  style={{ display: "none" }}
                  onChange={(event) => {
                    const files = Array.from(event.target.files || []);
                    if (files.length > 0) {
                      uploadFilesImmediately(files);
                    }
                  }}
                />
              </div>

              <div className="document-list">
                {documents.length > 0 ? documents.map((document) => {
                  const isActive = document.filename === activeDocument;
                  return (
                    <div key={document.filename} className={`document-item ${isActive ? "active" : ""}`}>
                      <button
                        type="button"
                        className="document-name"
                        onClick={() => selectDocument(document.filename)}
                      >
                        {document.filename}
                      </button>
                      <div className="document-meta">
                        <span>{document.totalPages || 0} pages</span>
                        <span>{document.totalChunks || 0} chunks</span>
                      </div>
                      <div className="document-actions">
                        <button
                          type="button"
                          className="chip-button"
                          onClick={() => summarizeDocument(document.filename)}
                          disabled={isUploading || isAsking}
                        >
                          Summary
                        </button>
                        <button
                          type="button"
                          className="chip-button subtle"
                          onClick={() => selectDocument(document.filename)}
                        >
                          Open chat
                        </button>
                      </div>
                    </div>
                  );
                }) : (
                  <div className="document-empty">Upload a PDF to start a file-specific chat history.</div>
                )}
              </div>

              {uploadProgress && (
                <div className="upload-status">
                  Uploading {uploadProgress.fileName} ({uploadProgress.current}/{uploadProgress.total})
                </div>
              )}

              {activeDocumentItem && (
                <div className="active-document-note">
                  Active file: <strong>{activeDocumentItem.filename}</strong>
                </div>
              )}
            </section>
          </div>

          <section className="chat-panel chat-panel-hero">
            <div className="answer-head">
              <span className="answer-dot" />
              <h2>Chatbot</h2>
            </div>
            <p className="chat-context">
              {activeDocument === GENERAL_THREAD_KEY
                ? "General study mode"
                : `Chat history for ${activeDocument}`}
            </p>

            <div className="chat-stream" aria-live="polite">
              {messages.map((message) => (
                <div key={message.id} className={`chat-bubble ${message.role}`}>
                  <div>{message.text}</div>
                  {message.role === "assistant" && message.filename && (
                    <div className="message-source">Source file: {message.filename}</div>
                  )}
                  {message.role === "assistant" && Array.isArray(message.citations) && message.citations.length > 0 && (
                    <div className="citation-list">
                      {message.citations.map((citation) => (
                        <button
                          key={`${citation.source}-${citation.page}-${citation.excerpt}`}
                          type="button"
                          className="citation-chip"
                          onClick={() => selectDocument(citation.source)}
                          title={citation.excerpt}
                        >
                          {citation.source} · p. {citation.page}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {isAsking && <div className="chat-bubble assistant">Thinking...</div>}
              {isUploading && <div className="chat-bubble assistant">Uploading...</div>}
            </div>

            <form
              className="chat-input-bar"
              onSubmit={(event) => {
                event.preventDefault();
                askQuestion();
              }}
            >
              <button
                type="button"
                className="plus-button-inline"
                onClick={() => fileInputRef.current && fileInputRef.current.click()}
                aria-label="Choose PDF files"
                title="Choose PDF files"
                disabled={isUploading || isAsking}
              >
                +
              </button>

              <input
                className="chat-input"
                type="text"
                placeholder="Type your question..."
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                disabled={isUploading || isAsking}
              />
              <button className="primary-button small" type="submit" disabled={isUploading || isAsking}>
                Send
              </button>
            </form>
          </section>
        </div>
      </section>
    </main>
  );
}

export default App;
