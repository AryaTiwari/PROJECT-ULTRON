import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeRecipe } from "../src/recipe.mjs";
import { sceneSvg } from "../src/svg.mjs";
import { createReelJob,getReelJob } from "../src/engine.mjs";

const sample={title:"Why creators plateau",objective:"Educate Elevate prospects",scenes:[
  {type:"hook",duration:1.2,eyebrow:"CONTENT DIAGNOSIS",title:"Your views are not the real problem"},
  {type:"retention",duration:2.2,title:"Your audience leaves here",points:[100,78,54,42,38]},
  {type:"cta",duration:1.4,title:"Fix the system, not one Reel",cta:"Build your creator OS"}
]};
test("recipe locks Instagram-safe rendering spec",()=>{
  const r=normalizeRecipe(sample);assert.equal(r.width,1080);assert.equal(r.height,1920);assert.equal(r.fps,30);assert.equal(r.scenes.length,3);
});
test("scene SVG stays deterministic and branded",()=>{
  const r=normalizeRecipe(sample),svg=sceneSvg(r.scenes[0],r);assert.match(svg,/ELEVATE/);assert.match(svg,/Your views are not/);assert.match(svg,/the real problem/);assert.match(svg,/1080/);
});
test("job creation writes recipe and SVG scenes without rendering",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"ultron-reel-"));const job=createReelJob(sample,{root});assert.equal(job.status,"ready");assert.equal(getReelJob(job.id,{root}).sceneCount,3);assert.equal(fs.readdirSync(path.join(root,job.id,"scenes")).length,3);fs.rmSync(root,{recursive:true,force:true});
});
