
import test from "node:test";
import assert from "node:assert/strict";
import {encodeBatch,decodeResponse,UnsupportedInput,InvalidResponse} from "./protocol.mjs";
const batch = {
 state:"货物尚未电放，ETA 明天，需要联系起运港。",
 questions:{
  "是否紧急/urgent":{type:"boolean",instructions:"Is this urgent?",criteria:{true:"ETA within 2 days with pending release",false:"No near-term impact"}},
  route:{type:"choice",instructions:"Choose a team",criteria:{"关务/customs":"Customs clearance","海运/ocean":"Ocean freight and cargo release"}},
  severity:{type:"score",instructions:"Rate severity",criteria:["None","Moderate","Critical"]}
 }
};
function response() {
 return {success:true,result:{model:"clef-flash",answers:{
  q0:{type:"noul",noul:0.97},
  q1:{type:"choice",choice:"c1",probabilities:{c0:0.08,c1:0.92},confidence:0.8},
  q2:{type:"score",score:1.7,legend:{"0":"None","1":"Moderate","2":"Critical"},probabilities:{"0":0.1,"1":0.1,"2":0.8},confidence:0.7}
 },usage:{input_tokens:410,output_tokens:0}}};
}
test("vendor System One fixture preserves probabilities, score order, unicode identifiers and usage",()=>{
 const req=encodeBatch(batch,"clef-flash");
 assert.deepEqual(Object.keys(req.payload.questions),["q0","q1","q2"]);
 assert.equal(req.payload.questions.q0.type,"noul");
 const r=decodeResponse(response(),req);
 assert.deepEqual(r.answers["是否紧急/urgent"],{type:"boolean",probabilityTrue:0.97});
 assert.equal(r.answers.route.choice,"海运/ocean");
 assert.deepEqual(r.answers.route.probabilities,{"关务/customs":0.08,"海运/ocean":0.92});
 assert.deepEqual(r.answers.severity.probabilities,[0.1,0.1,0.8]);
 assert.deepEqual(r.usage,{inputTokens:410,outputTokens:0});
});
test("reject missing probabilities, nonfinite scores and foreign choices instead of inventing certainty",()=>{
 const req=encodeBatch(batch,"clef-flash");
 for (const mutate of [
  r=>{delete r.result.answers.q0;},
  r=>{r.result.answers.q0.noul=1.1;},
  r=>{r.result.answers.q1.choice="unlisted";},
  r=>{r.result.answers.q1.probabilities.c0=0.9;},
  r=>{r.result.answers.q2.score=Infinity;},
  r=>{delete r.result.answers.q2.probabilities["1"];},
  r=>{r.result.model="other";}
 ]) { const r=response(); mutate(r); assert.throws(()=>decodeResponse(r,req),InvalidResponse); }
});
test("reject oversized evidence and unsupported score rubrics before network I/O",()=>{
 assert.throws(()=>encodeBatch({...batch,state:"x".repeat(24576)},"clef-flash"),UnsupportedInput);
 assert.throws(()=>encodeBatch({state:"x",questions:{s:{type:"score",criteria:Array(11).fill("x")}}},"clef"),UnsupportedInput);
 assert.throws(()=>encodeBatch(batch,"not-a-clef-model"),UnsupportedInput);
});
test("round-trips untrusted map keys without object prototype mutation",()=>{
 const criteria=JSON.parse('{"__proto__":"A","constructor":"B"}');
 const b={state:"x",questions:JSON.parse('{"__proto__":{"type":"choice","criteria":{"__proto__":"A","constructor":"B"}}}')};
 const req=encodeBatch(b,"clef-flash");
 const r=decodeResponse({model:"clef-flash",answers:{q0:{type:"choice",choice:"c0",probabilities:{c0:0.8,c1:0.2}}}},req);
 assert.equal(r.answers["__proto__"].choice,"__proto__");
 assert.equal(Object.getPrototypeOf(r.answers),null);
 assert.equal(Object.prototype.polluted,undefined);
});

test("extracts embedded data-URL images into the CLEF images array with placeholders",()=>{
  const url="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const b={state:{pic:url,nested:{imgs:[url,{content_type:"image/jpeg",base64:"Zm9v"}]}},
    questions:{q1:{type:"boolean",criteria:{true:"yes",false:"no"}}}};
  const req=encodeBatch(b,"clef-flash");
  assert.equal(req.payload.images.length,3);
  assert.equal(req.payload.state.pic,"[image #1]");
  assert.equal(req.payload.state.nested.imgs[0],"[image #2]");
  assert.equal(req.payload.state.nested.imgs[1],"[image #3]");
  assert.ok(!("images" in req.payload) === false);
  // no images -> no images key on the wire
  const plain=encodeBatch({state:"x",questions:{q1:{type:"boolean",criteria:{true:"y",false:"n"}}}},"clef-flash");
  assert.equal("images" in plain.payload,false);
});
