// AssemblyAI speech-to-text (official `assemblyai` SDK). Diarization, word timestamps,
// sentences, language detection and confidence. Never translates.
import { AssemblyAI } from "assemblyai";
import { permanent, transient, classifyError } from "../../utils/errors.js";

export class Transcriber {
  /** @returns {Promise<{ raw: object, sentences: object[]|null, metadata: object }>} */
  async transcribe(audioPath, options = {}) { throw new Error("not implemented"); } // eslint-disable-line no-unused-vars
  get name() { return "base"; }
}

export class AssemblyAITranscriber extends Transcriber {
  constructor({ apiKey, speechModels = ["universal-3-5-pro", "universal-2"], expectedLanguages = ["hi", "en"], timeoutMs = 900_000, client } = {}) {
    super();
    if (!apiKey && !client) throw permanent("PROVIDER_NOT_CONFIGURED", "ASSEMBLYAI_API_KEY is not configured");
    this.client = client || new AssemblyAI({ apiKey });
    Object.assign(this, { speechModels, expectedLanguages, timeoutMs });
  }
  get name() { return "assemblyai"; }

  async transcribe(audioPath, { languageCode, speakersExpected } = {}) {
    const started = Date.now();
    const params = {
      audio: audioPath,
      speech_models: this.speechModels,
      speaker_labels: true,
      ...(speakersExpected ? { speakers_expected: speakersExpected } : { speaker_options: { min_speakers_expected: 1, max_speakers_expected: 10 } }),
      punctuate: true,
      format_text: true,
      ...(languageCode
        ? { language_code: languageCode }
        : {
            language_detection: true,
            language_detection_options: {
              ...(this.expectedLanguages.length ? { expected_languages: this.expectedLanguages } : {}),
              code_switching: true, // Hinglish and other mixed-language speech
            },
          }),
    };

    let raw;
    try {
      raw = await this.client.transcripts.transcribe(params, { pollingInterval: 3000, pollingTimeout: this.timeoutMs });
    } catch (e) {
      throw classifyError(e);
    }
    if (raw.status === "error") {
      const msg = raw.error || "AssemblyAI returned an error";
      // Audio-content problems are permanent; service-side problems are retryable.
      if (/no spoken audio|audio duration is too short|file does not appear to contain audio|unsupported|language confidence/i.test(msg))
        throw permanent("TRANSCRIPTION_REJECTED", msg);
      throw transient("TRANSCRIPTION_FAILED", msg);
    }

    let sentences = null;
    try {
      sentences = (await this.client.transcripts.sentences(raw.id)).sentences ?? null;
    } catch { /* optional enrichment — transcript is still usable without it */ }

    return {
      raw,
      sentences,
      metadata: {
        provider: this.name,
        transcript_id: raw.id,
        speech_model_used: raw.speech_model_used ?? null,
        language_code: raw.language_code ?? null,
        language_confidence: raw.language_confidence ?? null,
        code_switching_languages: raw.language_detection_results?.code_switching_languages ?? null,
        confidence: raw.confidence ?? null,
        audio_duration: raw.audio_duration ?? null,
        diarization_available: Array.isArray(raw.utterances),
        latency_ms: Date.now() - started,
        usage: { audio_seconds: raw.audio_duration ?? null },
      },
    };
  }
}

/** Mock transcriber: returns AssemblyAI-shaped fixtures keyed by video id or audio path. */
export class MockTranscriber extends Transcriber {
  constructor({ fixtures = {}, defaultFixture = null, failWith = null } = {}) {
    super();
    Object.assign(this, { fixtures, defaultFixture, failWith });
    this.calls = [];
  }
  get name() { return "mock"; }
  async transcribe(audioPath, { videoKey } = {}) {
    this.calls.push(videoKey ?? audioPath);
    if (this.failWith) throw this.failWith;
    const raw = structuredClone(this.fixtures[videoKey] ?? this.defaultFixture);
    if (!raw) throw permanent("TRANSCRIPTION_FAILED", "Mock transcriber has no fixture");
    if (raw.__error) throw raw.__error;
    return { raw, sentences: raw.__sentences ?? null, metadata: { provider: this.name, language_code: raw.language_code, language_confidence: raw.language_confidence ?? null, confidence: raw.confidence ?? null, diarization_available: Array.isArray(raw.utterances) } };
  }
}
