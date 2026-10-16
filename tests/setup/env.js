// Runs in every test worker before modules load: force a hermetic, offline configuration.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@localhost:54329/reelscript_test";
// Tests never use the Neon database configured in .env (dotenv does not override variables that are already set).
process.env.DATABASE_URL_UNPOOLED = "";
process.env.DB_SSL = "";
process.env.QUEUE_DRIVER = "memory";
process.env.DOWNLOADER = "mock";
process.env.TRANSCRIBER = "mock";
process.env.ANALYZER = "mock";
process.env.EMBEDDING_PROVIDER = "hash";
process.env.SKILL_MODE = "mock";
process.env.GEMINI_API_KEY = "";
process.env.ASSEMBLYAI_API_KEY = "";
process.env.ANTHROPIC_API_KEY = "";
process.env.TEMP_VIDEO_DIR = "tests/.tmp/videos";
process.env.TEMP_AUDIO_DIR = "tests/.tmp/audio";
process.env.SKILL_EXCHANGE_DIR = "tests/.tmp/skill-exchange";
