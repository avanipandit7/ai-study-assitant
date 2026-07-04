# 📚 AI Study Assistant

An AI-powered study companion that lets you upload PDF documents, ask questions, and get answers with page citations — all through a beautiful, interactive chat interface.

## ✨ Features

- **PDF Upload & Processing** — Upload one or more PDFs; the backend splits them into searchable chunks and stores them in a vector database.
- **Question Answering** — Ask questions about your uploaded documents and receive extractive answers pulled directly from the PDF text.
- **Document Summaries** — Generate concise summaries of any uploaded PDF with a single click.
- **Page Citations** — Every answer includes clickable citations showing the source file and page number.
- **Per-Document Chat History** — Each uploaded PDF gets its own chat thread, so conversations stay organized.
- **General Study Mode** — Ask study questions even without a PDF uploaded.
- **Offline Fallback** — Built-in fallback answers for common topics when the backend is unreachable.
- **Persistent State** — Chat history and document list are saved in `localStorage` so nothing is lost on refresh.
- **Interactive UI** — Glassmorphism design with a custom WebGL gradient shader background and ripple effects.

## 🛠️ Tech Stack

### Frontend
- **React 19** — UI framework
- **Vite** — Build tool and dev server
- **Three.js / React Three Fiber** — WebGL gradient shader background
- **Vanilla CSS** — Custom glassmorphism design system

### Backend
- **FastAPI** — Python REST API
- **LangChain** — Document loading, text splitting, and retrieval
- **ChromaDB** — Local vector database for semantic search
- **HuggingFace Embeddings** — `sentence-transformers/all-MiniLM-L6-v2` for text embeddings
- **PyPDFLoader** — PDF parsing

## 📁 Project Structure

```
ai-study-assistant/
├── frontend/                   # React + Vite frontend
│   ├── public/                 # Static assets
│   ├── src/
│   │   ├── components/
│   │   │   └── ui/
│   │   │       └── gradient-shader-card.jsx   # WebGL shader background
│   │   ├── App.jsx             # Main application component
│   │   ├── index.css           # Global styles & design system
│   │   └── main.jsx            # React entry point
│   ├── index.html              # HTML entry point
│   ├── package.json            # Dependencies & scripts
│   └── vite.config.js          # Vite configuration
│
├── backend/                    # FastAPI backend
│   ├── main.py                 # API routes & PDF processing logic
│   ├── .env                    # Environment variables (not committed)
│   ├── chroma_db/              # Vector database storage (auto-generated)
│   └── venv/                   # Python virtual environment (not committed)
│
├── .gitignore
└── README.md
```

## 🚀 Getting Started

### Prerequisites

- **Node.js** (v18 or later)
- **Python** (3.9 or later)
- **pip** (Python package manager)

### 1. Clone the repository

```bash
git clone https://github.com/avanipandit7/ai-study-assitant.git
cd ai-study-assitant
```

### 2. Set up the backend

```bash
cd backend

# Create a virtual environment
python -m venv venv

# Activate it
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install fastapi uvicorn python-dotenv langchain langchain-community chromadb sentence-transformers pypdf pydantic

# Create a .env file
echo OPENAI_API_KEY=your_api_key_here > .env

# Start the server
uvicorn main:app --reload --port 8000
```

The backend will be running at `http://localhost:8000`.

### 3. Set up the frontend

```bash
cd frontend

# Install dependencies
npm install

# Start the dev server
npm run dev
```

The frontend will be running at `http://localhost:5173`.

## 📡 API Endpoints

| Method | Endpoint    | Description                        | Body                                      |
|--------|-------------|------------------------------------|--------------------------------------------|
| GET    | `/`         | Health check                       | —                                          |
| POST   | `/upload`   | Upload a PDF for processing        | `multipart/form-data` with `file` field    |
| POST   | `/ask`      | Ask a question about a document    | `{ "question": "...", "filename": "..." }` |
| POST   | `/summary`  | Generate a summary of a document   | `{ "filename": "..." }`                    |

### Example: Ask a question

```bash
curl -X POST http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "What is RISC?", "filename": "COA NOTES.pdf"}'
```

## 🌐 Deployment

### Frontend (Vercel)

1. Push the repo to GitHub.
2. Import the project on [Vercel](https://vercel.com).
3. Set **Root Directory** to `frontend`.
4. Add environment variable:
  - **VITE_API_URL** → your deployed backend URL (example: `https://your-backend.onrender.com`)
4. Vercel auto-detects Vite and sets:
   - **Build Command** → `npm run build`
   - **Output Directory** → `dist`
5. Deploy.

### Backend (Render / Railway / Fly.io)

The FastAPI backend needs a Python runtime and cannot run on Vercel's static hosting. Deploy it on a platform like **Render**, **Railway**, or **Fly.io**:

1. Point the platform to the `backend/` directory.
2. Set the start command to: `uvicorn main:app --host 0.0.0.0 --port $PORT`
3. Add environment variable:
  - **ALLOWED_ORIGINS** → your frontend URL (example: `https://avanipandit7-ai-study-assistant.vercel.app`)
4. Keep CORS open (`*`) only for quick testing. For production, always set `ALLOWED_ORIGINS`.
5. Ensure the URL in frontend `VITE_API_URL` points to this backend service.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## 📝 License

This project is open source and available under the [MIT License](LICENSE).
