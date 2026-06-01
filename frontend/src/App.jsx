import { Suspense, useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import GrainyGradient from "./components/ui/gradient-shader-card";

const STORAGE_KEY = "ai-study-assistant.state.v1";
const GENERAL_THREAD_KEY = "__general__";
const BASE_URL = `http://${window?.location?.hostname || "127.0.0.1"}:8000`;

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
      `I could not reach the backend, but your file ${activeDocument} is still selected locally. `
      + "Try again after the server is back online so I can answer from that PDF and show page citations."
    );
  }

  if (documents.length > 0) {
    return (
      "I could not reach the backend, but your uploaded files are still listed locally. "
      + "Reconnect the server to continue asking questions from those PDFs."
    );
  }

  return "I could not reach the backend. Start the FastAPI server and try again.";
};

const loadState = () => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        threads: { [GENERAL_THREAD_KEY]: [createInitialMessage()] },
        documents: [],
        activeDocument: GENERAL_THREAD_KEY,
      };
    }

    const parsed = JSON.parse(raw);
    return {
      threads: parsed.threads && typeof parsed.threads === "object"
        ? parsed.threads
        : { [GENERAL_THREAD_KEY]: [createInitialMessage()] },
      documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      activeDocument: parsed.activeDocument || GENERAL_THREAD_KEY,
    };
  } catch {
    return {
      threads: { [GENERAL_THREAD_KEY]: [createInitialMessage()] },
      documents: [],
      activeDocument: GENERAL_THREAD_KEY,
    };
  }
};

function App() {
  const [state, setState] = useState(() => loadState());
  const [question, setQuestion] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isAsking, setIsAsking] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
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

    const response = await fetch(`${BASE_URL}/upload`, {
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

  const uploadSelectedFiles = async () => {
    if (!selectedFiles.length) {
      appendMessage(activeDocument, {
        id: Date.now(),
        role: "assistant",
        text: "Choose one or more PDF files first.",
      });
      return;
    }

    try {
      setIsUploading(true);
      const uploadedNames = [];

      for (let index = 0; index < selectedFiles.length; index += 1) {
        const uploaded = await uploadSingleFile(selectedFiles[index], index, selectedFiles.length);
        uploadedNames.push(uploaded.filename);
      }

      if (uploadedNames.length > 0) {
        setState((prev) => ({
          ...prev,
          activeDocument: uploadedNames[0],
        }));
      }

      setSelectedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (error) {
      appendMessage(activeDocument, {
        id: Date.now(),
        role: "assistant",
        text: `Upload failed: ${error.message}`,
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

      const response = await fetch(`${BASE_URL}/ask`, {
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
        text: `${createOfflineFallback(trimmedQuestion, threadKey, documents)}\n\nBackend note: ${error.message}`,
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

      const response = await fetch(`${BASE_URL}/summary`, {
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
      appendMessage(filename, {
        id: Date.now() + 1,
        role: "assistant",
        text: `Could not summarize ${filename}. ${error.message}`,
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
                Choose PDF files, preview them before upload, and generate summaries from the selected document.
              </p>

              <div className="file-picker">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => fileInputRef.current && fileInputRef.current.click()}
                  disabled={isUploading || isAsking}
                >
                  Choose PDFs
                </button>
                <button
                  type="button"
                  className="primary-button secondary"
                  onClick={uploadSelectedFiles}
                  disabled={isUploading || isAsking || selectedFiles.length === 0}
                >
                  Upload selected
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf"
                  multiple
                  style={{ display: "none" }}
                  onChange={(event) => {
                    const nextFiles = Array.from(event.target.files || []);
                    setSelectedFiles(nextFiles);
                  }}
                />
              </div>

              <div className="preview-card">
                <div className="preview-title">Selected files</div>
                {selectedFiles.length > 0 ? (
                  <div className="selected-file-list">
                    {selectedFiles.map((file) => (
                      <div key={`${file.name}-${file.size}`} className="selected-file-item">
                        <strong>{file.name}</strong>
                        <span>{Math.ceil(file.size / 1024)} KB</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="preview-empty">No files selected yet.</p>
                )}
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
