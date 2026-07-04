from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from typing import Optional
import os

from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.vectorstores import Chroma
from langchain_community.embeddings import HuggingFaceEmbeddings

import shutil
import re

# load environment variables
load_dotenv()

# create app
app = FastAPI()

# Parse allowed origins from env (comma-separated). Fall back to local dev URLs.
configured_origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
]
allowed_origins = configured_origins or [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

# enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# global vector database
vectorstore = None
# cache original page text for precise file-specific extraction
uploaded_page_cache = {}


def get_source_filter(source_name: Optional[str]):
    if not source_name:
        return None
    return {"source_name": source_name}


def fallback_answer(question: str, context: str) -> str:
    question_lower = question.lower().strip()

    if "risc" in question_lower and "cisc" in question_lower:
        return (
            "RISC (Reduced Instruction Set Computer) uses a smaller, simpler set of instructions. "
            "That usually makes decoding easier and execution more efficient. CISC (Complex Instruction Set Computer) "
            "uses richer instructions that can do more work per instruction, but they are more complex to decode. "
            "In short: RISC emphasizes simplicity and speed, while CISC emphasizes more powerful instructions and compact code."
        )

    if "i/o module" in question_lower or question_lower == "what is i/o module" or question_lower.startswith("what is i/o"):
        return (
            "An I/O module is a hardware component that manages communication between the CPU, memory, and input/output devices. "
            "It helps control data transfer, buffering, status reporting, and device timing so the processor does not have to handle every low-level detail directly."
        )

    cleaned_context = " ".join(line.strip() for line in context.splitlines() if line.strip())
    if cleaned_context:
        excerpt = cleaned_context[:900]
        return (
            "I could not reach the online AI service, but I found this relevant text in your uploaded PDF: "
            f"{excerpt}"
        )

    return (
        "I could not reach the online AI service, and there is not enough local context to answer this yet. "
        "Please upload a PDF or try again once the AI service is available."
    )


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()


def extract_answer_from_cached_pages(question: str, source_name: Optional[str]):
    if not source_name:
        return None

    pages = uploaded_page_cache.get(source_name) or []
    if not pages:
        file_path = f"./{source_name}"
        if os.path.exists(file_path):
            try:
                loader = PyPDFLoader(file_path)
                loaded_docs = loader.load()
                pages = [
                    {
                        "page": int((document.metadata or {}).get("page", 0)) + 1,
                        "text": document.page_content or "",
                    }
                    for document in loaded_docs
                ]
                uploaded_page_cache[source_name] = pages
            except Exception:
                pages = []

    if not pages:
        return None

    question_lower = (question or "").lower().strip()
    stopwords = {
        "what", "is", "the", "a", "an", "of", "for", "to", "in", "on", "and", "or",
        "please", "tell", "me", "about", "explain", "with", "from", "this", "that"
    }
    query_tokens = [
        token for token in re.findall(r"\w+", question_lower)
        if len(token) > 2 and token not in stopwords
    ]

    section_headings = {
        "objective", "career objective", "professional objective", "summary", "profile",
        "education", "academic background", "experience", "work experience", "projects",
        "academic projects", "skills", "technical skills", "certifications", "achievements",
        "internship", "interests", "contact", "profile summary"
    }

    section_aliases = {
        "objective": ["objective", "career objective", "professional objective"],
        "education": ["education", "academic", "qualification"],
        "experience": ["experience", "work experience", "internship"],
        "projects": ["project", "projects"],
        "skills": ["skill", "skills", "technical skills"],
        "certifications": ["certification", "certifications"],
        "contact": ["contact", "email", "phone"],
        "summary": ["summary", "profile", "about"],
    }

    def canonical_heading(line: str) -> str:
        cleaned = (line or "").strip().lower().rstrip(":")
        cleaned = re.sub(r"\s+", " ", cleaned)
        return cleaned

    def looks_like_new_heading(line: str) -> bool:
        cleaned = (line or "").strip()
        lower = canonical_heading(cleaned)
        if not cleaned:
            return False
        if lower in section_headings:
            return True
        if re.match(r"^(education|experience|work experience|projects|skills|technical skills|summary|profile|objective|certifications|contact|achievements|internship)\b", lower):
            return True
        return False

    requested_section = None
    for section_name, aliases in section_aliases.items():
        if any(alias in question_lower for alias in aliases):
            requested_section = section_name
            break

    # First pass: if a question token appears in a heading-like line, return that section body.
    for page in pages:
        lines = [line.strip() for line in (page.get("text") or "").splitlines() if line.strip()]
        for i, line in enumerate(lines):
            lower = line.lower()
            if not any(token in lower for token in query_tokens):
                continue
            heading_key = canonical_heading(line)
            heading_matches_query = requested_section and requested_section in heading_key
            is_heading_candidate = (
                line.endswith(":")
                or heading_key in section_headings
                or re.match(r"^(career\s+)?objective\b", lower)
            )

            if is_heading_candidate and (heading_matches_query or not requested_section):
                collected = [line]
                min_lines_before_break = 3
                for j in range(i + 1, min(i + 24, len(lines))):
                    next_line = lines[j]
                    if (
                        looks_like_new_heading(next_line)
                        and len(collected) >= min_lines_before_break
                    ):
                        break
                    collected.append(next_line)
                    if len(" ".join(collected)) >= 2000:
                        break

                answer = "\n".join(collected).strip()
                if answer:
                    return {
                        "answer": answer,
                        "page": page.get("page", 1),
                    }

    # Second pass: score all lines by keyword overlap and return the best local window.
    best = None
    for page in pages:
        lines = [line.strip() for line in (page.get("text") or "").splitlines() if line.strip()]
        for i, line in enumerate(lines):
            tokens = [token for token in re.findall(r"\w+", line.lower()) if len(token) > 2]
            if not tokens:
                continue
            overlap = sum(1 for token in query_tokens if token in tokens)
            if overlap == 0:
                continue
            score = overlap / (len(tokens) + 1)
            if line.endswith(":"):
                score += 0.15
            candidate = (score, page.get("page", 1), i, lines)
            if best is None or candidate[0] > best[0]:
                best = candidate

    if best is None:
        return None

    _, page_number, line_idx, lines = best
    start = max(0, line_idx - 1)
    end = min(len(lines), line_idx + 16)
    snippet = []
    for idx in range(start, end):
        line = lines[idx]
        if len(snippet) >= 4 and looks_like_new_heading(line):
            break
        snippet.append(line)

    answer = "\n".join(snippet).strip()
    if not answer:
        return None

    return {
        "answer": answer,
        "page": page_number,
    }


def dedupe_preserve_order(items):
    seen = set()
    result = []
    for item in items:
        normalized = normalize_text(item)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(item)
    return result


def is_structured_line(line: str) -> bool:
    cleaned = (line or "").strip().lower()
    return bool(
        re.match(r"^(\d+[.)]|[-•●*])\s+", cleaned)
        or re.match(r"^[a-z]\)", cleaned)
    )


def reflow_pdf_lines(lines):
    paragraphs = []
    current = []

    for raw_line in lines:
        line = (raw_line or "").strip()
        if not line:
            continue

        if is_structured_line(line):
            if current:
                paragraphs.append(" ".join(current).strip())
                current = []
            paragraphs.append(line)
            continue

        if not current:
            current.append(line)
            continue

        previous = current[-1]
        if previous.endswith(":") or previous.endswith("-"):
            current[-1] = f"{previous} {line}".strip()
        else:
            current[-1] = f"{previous} {line}".strip()

    if current:
        paragraphs.append(" ".join(current).strip())

    return "\n\n".join(paragraphs).strip()


def normalize_file_name(file_name: str) -> str:
    return (file_name or "").strip()


def attach_document_metadata(documents, source_name: str):
    for document in documents:
        document.metadata = dict(document.metadata or {})
        document.metadata["source_name"] = source_name
        document.metadata["source"] = source_name
    return documents


def format_citations(documents, max_citations: int = 4):
    citations = []
    seen = set()

    for document in documents:
        metadata = document.metadata or {}
        source_name = metadata.get("source_name") or metadata.get("source") or "Uploaded PDF"
        page_number = int(metadata.get("page", 0)) + 1
        excerpt = " ".join(document.page_content.split())[:180]
        if not excerpt:
            continue

        dedupe_key = f"{source_name}:{page_number}:{normalize_text(excerpt)}"
        if dedupe_key in seen:
            continue

        seen.add(dedupe_key)
        citations.append(
            {
                "source": source_name,
                "page": page_number,
                "excerpt": excerpt,
            }
        )

        if len(citations) >= max_citations:
            break

    return citations


def build_retriever(source_name: Optional[str] = None, k: int = 8):
    if vectorstore is None:
        return None

    search_kwargs = {"k": k}
    source_filter = get_source_filter(source_name)
    if source_filter:
        search_kwargs["filter"] = source_filter

    return vectorstore.as_retriever(search_kwargs=search_kwargs)


def gather_context(question: str, source_name: Optional[str] = None, k: int = 8):
    retriever = build_retriever(source_name=source_name, k=k)
    if retriever is None:
        return [], ""

    docs = retriever.invoke(question)
    unique_docs = []
    seen = set()

    for document in docs:
        text = document.page_content or ""
        normalized = normalize_text(text)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        unique_docs.append(document)

    context = "\n".join(doc.page_content for doc in unique_docs)
    return unique_docs, context


def context_match_count(question: str, context: str) -> int:
    question_tokens = {token for token in re.findall(r"\w+", (question or "").lower()) if len(token) > 2}
    context_tokens = {token for token in re.findall(r"\w+", (context or "").lower()) if len(token) > 2}
    return sum(1 for token in question_tokens if token in context_tokens)


def has_sufficient_context_match(question: str, context: str) -> bool:
    question_tokens = [token for token in re.findall(r"\w+", (question or "").lower()) if len(token) > 2]
    if not question_tokens:
        return False

    matched_tokens = context_match_count(question, context)
    required_matches = 2 if len(question_tokens) >= 4 else 1
    return matched_tokens >= required_matches


def summarize_context(question: str, context: str) -> str:
    if not context or not context.strip():
        return "No local PDF context available to summarize yet."

    lines = [line.strip() for line in context.replace("\r", "\n").split("\n") if line.strip()]
    deduped = dedupe_preserve_order(lines)
    if not deduped:
        return context[:900]

    keywords = [w for w in re.findall(r"\w+", question.lower()) if len(w) > 2]
    scored = []

    for index, line in enumerate(deduped):
        lowered = line.lower()
        tokens = [w for w in re.findall(r"\w+", lowered) if len(w) > 2]
        overlap = sum(1 for token in keywords if token in tokens)
        score = overlap / (len(tokens) + 1)
        if lowered.startswith(("-", "•", "*", "●")):
            score += 0.08
        if any(marker in lowered for marker in ("definition", "summary", "important", "key", "features", "advantages", "disadvantages")):
            score += 0.12
        scored.append((score, index, line))

    scored.sort(key=lambda item: (item[0], -item[1]), reverse=True)
    top_lines = [item[2] for item in scored[:10] if item[2]]
    if not top_lines:
        top_lines = deduped[:10]

    summary_lines = []
    for line in top_lines:
        if line not in summary_lines:
            summary_lines.append(line)

    return "Document summary:\n" + reflow_pdf_lines(summary_lines[:8])


def extractive_answer_from_context(question: str, context: str, max_sentences: int = 3) -> str:
    """Return a short extractive answer by selecting the most relevant lines from the context.

    This works better for study notes because it preserves headings, numbered lists, and bullets.
    The function looks for the best matching line, then expands to nearby lines so the answer
    includes the definition and the supporting list items that follow it.
    """
    if not context or not context.strip():
        return "No local PDF context available to answer this question."

    question_lower = question.lower().strip()
    question_tokens = [w for w in re.findall(r"\w+", question_lower) if len(w) > 2]
    is_broad_question = any(
        keyword in question_lower for keyword in ("explain", "describe", "discuss", "write", "notes")
    )

    # Keep the document structure: one line per note line, preserving bullets and numbered items.
    raw_lines = [line.strip() for line in context.replace("\r", "\n").split("\n")]
    lines = dedupe_preserve_order([line for line in raw_lines if line])
    if not lines:
        return context[:900]

    def score_line(line: str) -> float:
        tokens = [w for w in re.findall(r"\w+", line.lower()) if len(w) > 2]
        if not tokens:
            return 0.0
        overlap = sum(1 for t in question_tokens if t in tokens)
        heading_bonus = 0.0
        lower = line.lower()
        if lower.startswith(tuple(str(i) + "." for i in range(1, 10))) or lower.startswith(("-", "●", "•", "*")):
            heading_bonus = 0.1
        if any(keyword in lower for keyword in ("explain", "definition", "causes", "effects", "advantages", "disadvantages")):
            heading_bonus = 0.25
        return (overlap / (len(tokens) + 1)) + heading_bonus

    scored_lines = [(score_line(line), idx, line) for idx, line in enumerate(lines)]
    scored_lines.sort(key=lambda item: (item[0], -item[1]), reverse=True)

    best_score, best_idx, best_line = scored_lines[0]

    # If there is no obvious match, return a short clean excerpt from the top of the PDF text.
    if best_score <= 0:
        excerpt = " ".join(lines[: min(len(lines), 12)])
        return excerpt[:1200]

    # Expand around the best matching line so we capture the definition + the bullets that follow.
    start = max(0, best_idx - 1)
    end = min(len(lines), best_idx + (22 if is_broad_question else 10))

    # If the best line is a section heading (e.g. "Causes of Software Crisis"), keep following lines.
    if re.search(r"\b(causes|effects|types|advantages|disadvantages|steps|features|characteristics)\b", best_line.lower()):
        end = min(len(lines), best_idx + (26 if is_broad_question else 14))

    selected = []
    for line in lines[start:end]:
        normalized = normalize_text(line)
        if not normalized or normalized in {normalize_text(item) for item in selected}:
            continue
        selected.append(line)

    # If the selected window is still too small, append a few more nearby lines that look like bullets.
    if len(selected) < 4:
        for line in lines[end : min(len(lines), end + 8)]:
            normalized = normalize_text(line)
            if not normalized or normalized in {normalize_text(item) for item in selected}:
                continue
            selected.append(line)

    max_output_lines = 24 if is_broad_question else (max_sentences + 6)
    answer_lines = selected[:max_output_lines]
    answer_text = "\n".join(answer_lines).strip()
    return answer_text


# home route
@app.get("/")
def home():
    return {"message": "Backend working"}


# upload pdf route
@app.post("/upload")
async def upload_pdf(file: UploadFile = File(...)):

    global vectorstore
    global uploaded_page_cache

    try:
        source_name = normalize_file_name(file.filename)

        # save uploaded pdf
        file_path = f"./{file.filename}"

        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        # load pdf
        loader = PyPDFLoader(file_path)
        documents = loader.load()
        uploaded_page_cache[source_name] = [
            {
                "page": int((document.metadata or {}).get("page", 0)) + 1,
                "text": document.page_content or "",
            }
            for document in documents
        ]

        # split text
        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=500,
            chunk_overlap=50
        )

        chunks = text_splitter.split_documents(documents)
        chunks = attach_document_metadata(chunks, source_name)

        # embeddings model
        embeddings = HuggingFaceEmbeddings(
            model_name="sentence-transformers/all-MiniLM-L6-v2"
        )

        # store in chromadb
        if vectorstore is None:
            vectorstore = Chroma(
                persist_directory="./chroma_db",
                embedding_function=embeddings,
            )

        vectorstore.add_documents(chunks)

        return {
            "filename": source_name,
            "total_chunks": len(chunks),
            "total_pages": len(documents),
            "message": "Stored in chroma db successfully"
        }

    except Exception as e:
        return {
            "error": str(e)
        }


# question model
class QuestionRequest(BaseModel):
    question: str
    filename: Optional[str] = None


class SummaryRequest(BaseModel):
    filename: Optional[str] = None


# ask ai route
@app.post("/ask")
async def ask_question(data: QuestionRequest):

    global vectorstore
    global uploaded_page_cache

    try:
        source_name = normalize_file_name(data.filename) if data.filename else None

        # Prefer precise extraction from the selected file's original page text.
        direct_answer = extract_answer_from_cached_pages(data.question, source_name)
        if direct_answer:
            return {
                "question": data.question,
                "answer": direct_answer["answer"],
                "source": "pdf",
                "filename": source_name,
                "citations": [
                    {
                        "source": source_name,
                        "page": int(direct_answer.get("page", 1)),
                        "excerpt": " ".join((direct_answer.get("answer") or "").split())[:180],
                    }
                ],
            }

        # retrieve relevant chunks when a PDF has been uploaded
        if vectorstore is None:
            return {
                "question": data.question,
                "answer": fallback_answer(data.question, ""),
                "source": "fallback",
                "citations": []
            }

        docs, context = gather_context(data.question, source_name=source_name, k=8)

        if not context.strip() or not has_sufficient_context_match(data.question, context):
            return {
                "question": data.question,
                "answer": fallback_answer(data.question, ""),
                "source": "fallback",
                "citations": []
            }

        answer = extractive_answer_from_context(data.question, context)
        return {
            "question": data.question,
            "answer": answer,
            "source": "pdf",
            "filename": source_name,
            "citations": format_citations(docs)
        }

    except Exception as e:
        return {
            "error": str(e)
        }


@app.post("/summary")
async def summarize_document(data: SummaryRequest):

    global vectorstore

    try:
        source_name = normalize_file_name(data.filename) if data.filename else None

        if vectorstore is None:
            return {
                "error": "Please upload a PDF first so I can summarize it."
            }

        docs, context = gather_context("summary", source_name=source_name, k=12)
        if not context.strip():
            return {
                "error": "I could not find any text to summarize for that document."
            }

        summary = summarize_context("summary", context)
        return {
            "filename": source_name,
            "summary": summary,
            "source": "pdf",
            "citations": format_citations(docs, max_citations=3)
        }

    except Exception as e:
        return {
            "error": str(e)
        }