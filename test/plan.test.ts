import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL,
  Panic,
  newPlan,
  errorPlan,
  isErrorPlan,
  serializePlan,
  parsePlan,
} from "../src/core/plan.ts";

const panicWith = (code: string) => (err: unknown) =>
  err instanceof Panic && err.code === code;

test("ok plan roundtrips through serialize/parse", () => {
  const plan = newPlan(["D:/photos/a.jpg", "D:/photos/b.jpg"]);
  plan.ops.push({ op: "resize", width: 1600, height: null, fit: "inside", upscale: false });
  plan.ops.push({ op: "grayscale" });

  const parsed = parsePlan(serializePlan(plan));
  assert.deepEqual(parsed, plan);
});

test("serialized plan is one ASCII-only line", () => {
  const plan = newPlan(["D:/photos/ફોટુ-૧.jpg"]);
  const out = serializePlan(plan);

  assert.ok(out.endsWith("\n"));
  assert.equal(out.indexOf("\n"), out.length - 1, "exactly one newline, at the end");
  for (let i = 0; i < out.length; i++) {
    assert.ok(out.charCodeAt(i) < 128, `non-ASCII byte at index ${i}`);
  }
  const parsed = parsePlan(out);
  assert.ok(!isErrorPlan(parsed));
  assert.equal((parsed as ReturnType<typeof newPlan>).files[0], "D:/photos/ફોટુ-૧.jpg");
});

test("non-JSON stdin panics ENOTPLAN", () => {
  assert.throws(() => parsePlan("PNG blob or whatever"), panicWith("ENOTPLAN"));
});

test("JSON without the photu marker panics ENOTPLAN", () => {
  assert.throws(() => parsePlan('{"foo": 1}'), panicWith("ENOTPLAN"));
  assert.throws(() => parsePlan('[1,2,3]'), panicWith("ENOTPLAN"));
  assert.throws(() => parsePlan('"photu"'), panicWith("ENOTPLAN"));
  assert.throws(() => parsePlan('{"photu": "one"}'), panicWith("ENOTPLAN"));
});

test("protocol version mismatch panics EVERSION", () => {
  assert.throws(
    () => parsePlan(`{"photu": ${PROTOCOL + 1}, "files": [], "ops": []}`),
    panicWith("EVERSION"),
  );
});

test("error plan roundtrips and is detected", () => {
  const plan = errorPlan("resize", "EBADARG", "invalid dimension '800x'");
  const parsed = parsePlan(serializePlan(plan));
  assert.ok(isErrorPlan(parsed));
  assert.deepEqual(parsed, plan);
});

test("malformed structures panic EMALFORMED", () => {
  assert.throws(
    () => parsePlan(`{"photu": ${PROTOCOL}, "error": {"stage": "x"}}`),
    panicWith("EMALFORMED"),
  );
  assert.throws(
    () => parsePlan(`{"photu": ${PROTOCOL}, "files": [1], "ops": []}`),
    panicWith("EMALFORMED"),
  );
  assert.throws(
    () => parsePlan(`{"photu": ${PROTOCOL}, "files": [], "ops": [{"no_op": true}]}`),
    panicWith("EMALFORMED"),
  );
  assert.throws(
    () => parsePlan(`{"photu": ${PROTOCOL}, "files": []}`),
    panicWith("EMALFORMED"),
  );
});
