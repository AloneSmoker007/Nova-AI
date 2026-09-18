import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkflowDefinition } from "../src/services/automation.service.js";

test("normalizes supported workflow actions",()=>{const w=normalizeWorkflowDefinition({steps:[{action:"send_message",body:"Hi"},{action:"wait",seconds:60},{action:"add_tag",tag:"lead"},{action:"condition",field:"customer.name",operator:"exists"},{action:"webhook",url:"https://example.com/hook"}]}); assert.equal(w.steps.length,5);});
test("rejects insecure webhooks",()=>{assert.throws(()=>normalizeWorkflowDefinition({steps:[{action:"webhook",url:"http://127.0.0.1"}]}),/HTTPS/);});
test("bounds workflow size and delays",()=>{assert.throws(()=>normalizeWorkflowDefinition({steps:Array.from({length:51},()=>({action:"wait",seconds:1}))}),/too many/);assert.throws(()=>normalizeWorkflowDefinition({steps:[{action:"wait",seconds:2592001}]}),/delay/);});
