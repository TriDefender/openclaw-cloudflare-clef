
/** SDK-free translation of OpenClaw's decision contract to CLEF's System One API. */
export class UnsupportedInput extends Error {}
export class InvalidResponse extends Error {}
const own = (o,k) => Object.hasOwn(o,k);
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const probability = x => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
const fail = () => { throw new InvalidResponse("Invalid CLEF decision response"); };
export function encodeBatch(batch, model) {
  if (!["clef","clef-flash"].includes(model) || !object(batch.questions))
    throw new UnsupportedInput("Unsupported model or questions");
  const entries = Object.entries(batch.questions);
  if (!entries.length || entries.length > 64) throw new UnsupportedInput("CLEF accepts 1–64 questions");
  // CLEF takes images only via its top-level "images" array (data URLs or
  // {content_type,base64} items; PNG/JPEG/WebP, max 4). OpenClaw's decision
  // contract has no image channel, so callers may embed data URLs anywhere in
  // state/instructions/criteria. Extract them all here and leave a textual
  // placeholder so the model can tie each image back to its context.
  const images = [];
  const transform = (x) => {
    if (typeof x === "string") {
      const t = x.trim();
      if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=\s]+$/.test(t)) {
        images.push(t);
        return "[image #" + images.length + "]";
      }
      return x;
    }
    if (Array.isArray(x)) return x.map(transform);
    if (x !== null && typeof x === "object") {
      if (typeof x.content_type === "string" && typeof x.base64 === "string") {
        images.push({content_type:x.content_type, base64:x.base64});
        return "[image #" + images.length + "]";
      }
      const o = Object.create(null);
      for (const k of Object.keys(x)) o[k] = transform(x[k]);
      return o;
    }
    return x;
  };
  const questions = Object.create(null), mapping = [];
  let alternatives = 0;
  for (const [id,qRaw] of entries) {
    const q = transform(qRaw);
    const wireId = "q" + mapping.length;
    const instructions = q.instructions ?? (
      q.type === "boolean" ? "Does the supplied state satisfy the true criterion rather than the false criterion?" :
      q.type === "choice" ? "Choose the best matching criterion for the supplied state." :
      "Rate the supplied state on the ordered criteria from lowest to highest."
    );
    if (q.type === "boolean") {
      questions[wireId] = {type:"noul", instructions, ...(q.criteria ? {criteria:q.criteria}: {})};
      mapping.push({id,wireId,q}); alternatives += 2;
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria ?? {});
      if (keys.length < 2 || keys.length > 255) throw new UnsupportedInput("CLEF accepts 2–255 choices");
      const criteria = Object.create(null);
      keys.forEach((key,i) => { criteria["c"+i] = {label:key, description:q.criteria[key]}; });
      questions[wireId] = {type:"choice",instructions,criteria};
      mapping.push({id,wireId,q,keys}); alternatives += keys.length;
    } else if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10 || q.criteria.some(v=>v===null))
        throw new UnsupportedInput("CLEF accepts 2–10 non-null score criteria");
      questions[wireId] = {type:"score",instructions,criteria:q.criteria};
      mapping.push({id,wireId,q}); alternatives += q.criteria.length;
    } else throw new UnsupportedInput("Unsupported question type");
  }
  const payload = {model,state:transform(batch.state),questions};
  if (images.length) payload.images = images;
  const body = JSON.stringify(payload);
  // Conservative admission guard: one UTF-8 byte per token plus per-rubric
  // headroom. Reject oversized evidence rather than rely on CLEF truncation.
  if (Buffer.byteLength(body,"utf8") + 1024 + 128*alternatives > 24000)
    throw new UnsupportedInput("Evidence exceeds this adapter's conservative context budget");
  return {payload,body,mapping};
}
export function decodeResponse(envelope, request) {
  if (!object(envelope) || envelope.success === false) return fail();
  const raw = own(envelope,"result") ? envelope.result : envelope;
  if (!object(raw) || typeof raw.model !== "string" || raw.model !== request.payload.model ||
      !object(raw.answers) || Object.keys(raw.answers).length !== request.mapping.length) return fail();
  const answers = Object.create(null);
  for (const {id,wireId,q,keys} of request.mapping) {
    if (!own(raw.answers,wireId)) return fail();
    const a = raw.answers[wireId];
    if (!object(a)) return fail();
    if (q.type === "boolean") {
      if (a.type !== "noul" || !probability(a.noul)) return fail();
      answers[id] = {type:"boolean",probabilityTrue:a.noul};
    } else {
      if (a.type !== q.type || !object(a.probabilities)) return fail();
      const expected = q.type === "choice" ? keys.map((_,i)=>"c"+i) : q.criteria.map((_,i)=>String(i));
      if (Object.keys(a.probabilities).length !== expected.length ||
          expected.some(k=>!own(a.probabilities,k) || !probability(a.probabilities[k]))) return fail();
      const p = expected.map(k=>a.probabilities[k]);
      if (Math.abs(p.reduce((s,v)=>s+v,0)-1) > 0.03) return fail();
      if (a.confidence !== undefined && !probability(a.confidence)) return fail();
      const confidence = a.confidence === undefined ? {} : {confidence:a.confidence};
      if (q.type === "choice") {
        const index = expected.indexOf(a.choice);
        if (index < 0) return fail();
        answers[id] = {type:"choice",choice:keys[index],probabilities:Object.fromEntries(keys.map((k,i)=>[k,p[i]])),...confidence};
      } else {
        if (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < 0 || a.score > q.criteria.length-1) return fail();
        answers[id] = {type:"score",score:a.score,probabilities:p,...confidence};
      }
    }
  }
  const result = {model:raw.model,answers};
  if (raw.usage !== undefined) {
    if (!object(raw.usage)) return fail();
    const usage = {};
    for (const [wire,key] of [["input_tokens","inputTokens"],["output_tokens","outputTokens"]]) {
      const value = raw.usage[wire];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 0) return fail();
        usage[key] = value;
      }
    }
    result.usage = usage;
  }
  return result;
}
