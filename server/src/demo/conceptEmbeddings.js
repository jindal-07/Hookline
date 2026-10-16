// DEMO/TEST ONLY — deterministic multilingual embedding stand-in: maps English, Hindi (Devanagari) and
// romanised Hindi words onto shared concept dimensions, so cross-language meaning can be tested
// without calling a real embedding API.
import { EmbeddingService, l2normalize } from "../services/embeddings/EmbeddingService.js";
import { tokenize } from "../services/matching/text.js";

const CONCEPTS = {
  law: "constitution article rights right law legal अनुच्छेद अधिकार संविधान anuchhed adhikar samvidhan",
  life: "life liberty freedom जीवन स्वतंत्रता jeevan swatantrata",
  study: "study studies studying notes notebook exam exams books book reading preparation पढ़ाई किताबें किताब परीक्षा padhai kitab kitaben pariksha",
  tea: "tea chai चाय",
  demand: "demands demand calls bring hurry ready made बनी बना bani bana jaldi",
  officer: "officer officers ias collector अफसर आईएएस afsar",
  maid: "maid servant housemaid help नौकरानी naukrani",
  dream: "dream dreams ambition aspiration सपना सपने sapna sapne",
  mock: "mocks mock ridicule ridicules laughs mocking sneers हँसी मज़ाक hasi mazak dekho देखो",
  try: "trying try tries keep persist effort कोशिश koshish",
  wrong: "wrong harm bad बुराई burai",
  old: "old used पुरानी पुराने purani purane",
  give: "gives give offers offer hands take keep रख लो rakh lo",
  thank: "thanks thank grateful gratitude शुक्रिया धन्यवाद shukriya dhanyavad",
  roof: "roof rooftop terrace night छत रात chhat raat",
  meera: "meera मीरा",
  madam: "madam mrs kapoor employer मैडम madam",
  tears: "tears crying cries आँसू aansu",
  cricket: "cricket match bat ball wicket stadium क्रिकेट मैच",
  food: "food biryani dinner hungry restaurant खाना बिरयानी khana",
  weather: "weather rain umbrella monsoon बारिश छाता barish",
};
const INDEX = new Map();
Object.keys(CONCEPTS).forEach((c, i) => { for (const w of tokenize(CONCEPTS[c])) INDEX.set(w, i); });
const DIM = Object.keys(CONCEPTS).length;

export class ConceptEmbeddingService extends EmbeddingService {
  get info() {
    return { provider: "demo-concepts", model: "concept-bag", version: "test-1", multilingual: true, semantic: true, calibration: { floor: 0.1, ceil: 0.6 } };
  }
  async embed(texts) {
    return texts.map(t => {
      const v = new Array(DIM + 1).fill(0);
      v[DIM] = 0.05; // tiny shared component so unrelated texts aren't exactly orthogonal
      for (const w of tokenize(t)) if (INDEX.has(w)) v[INDEX.get(w)] += 1;
      return l2normalize(v);
    });
  }
}
