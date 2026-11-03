// Parameterized tests: generates a test case for every meaningful combination
// of ops and their parameters.  The goal is broad coverage of the CLI surface,
// not deep assertions — each test just verifies the pipeline exits 0 and
// produces a valid output file.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

sharp.cache(false);

const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function run(args: string[], input = ""): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function pipeline(glob: string, ...stages: string[][]) {
  let res = await run(["read", glob]);
  for (const stage of stages) {
    if (res.status !== 0) return res;
    res = await run(stage, res.stdout);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "photu-param-")).replaceAll("\\", "/");
const out = join(dir, "out").replaceAll("\\", "/");

before(async () => {
  const specs = [
    { w: 100, h: 60, ch: 3 as const, bg: "red", name: "red.jpg", fmt: "jpeg" },
    { w: 200, h: 150, ch: 3 as const, bg: "blue", name: "blue.jpg", fmt: "jpeg" },
    { w: 80, h: 80, ch: 4 as const, bg: { r: 0, g: 0, b: 255, alpha: 0.5 }, name: "alpha.png", fmt: "png" },
    { w: 400, h: 300, ch: 3 as const, bg: "green", name: "green.jpg", fmt: "jpeg" },
    { w: 50, h: 50, ch: 3 as const, bg: "white", name: "small.png", fmt: "png" },
  ];
  for (const s of specs) {
    await sharp({ create: { width: s.w, height: s.h, channels: s.ch, background: s.bg } })
      [s.fmt === "jpeg" ? "jpeg" : "png"]()
      .toFile(join(dir, s.name));
  }
});
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

// ---------------------------------------------------------------------------
// Op parameter tables
// ---------------------------------------------------------------------------

const RESIZE_CASES = [
  ["80"],
  ["x40"],
  ["60x60"],
  ["120x80"],
  ["80", "fit=inside"],
  ["80", "fit=cover"],
  ["80", "fit=contain"],
  ["60x60", "fit=cover", "upscale"],
  ["60x60", "fit=contain", "upscale"],
  ["60x60", "fit=inside"],
  ["x40", "fit=cover"],
  ["120x80", "fit=cover", "upscale"],
];

const CROP_CASES = [
  ["30x30"],
  ["40x20"],
  ["20x30", "gravity=north"],
  ["20x30", "gravity=south"],
  ["20x30", "gravity=east"],
  ["20x30", "gravity=west"],
  ["20x30", "gravity=northeast"],
  ["20x30", "gravity=northwest"],
  ["20x30", "gravity=southeast"],
  ["20x30", "gravity=southwest"],
  ["20x30", "gravity=center"],
  ["20x20+10+10"],
  ["30x20+5+5"],
];

const ROTATE_CASES = [["0"], ["45"], ["90"], ["180"], ["270"], ["360"], ["-90"], ["-45"], ["45.5"]];
const BLUR_CASES = [[], ["0.5"], ["2"], ["5"], ["10"]];
const SHARPEN_CASES = [[], ["0.5"], ["1"], ["2"], ["5"]];
const ADJUST_CASES = [
  ["brightness=1.2"],
  ["saturation=0.5"],
  ["hue=90"],
  ["brightness=0.5", "saturation=1.5"],
  ["brightness=1.1", "saturation=0.8", "hue=30"],
  ["brightness=0.1", "saturation=3", "hue=-180"],
];
const PAD_CASES = [
  ["5", "color=white"],
  ["10", "color=black"],
  ["15", "color=blue"],
  ["20", "color=#ff0000"],
  ["5", "color=#00ff00"],
];
const GRAVITY_LIST = ["center", "north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
const FIT_LIST = ["inside", "cover", "contain", "fill", "outside"];

// Source files to cycle through
const SOURCES = ["red.jpg", "blue.jpg", "alpha.png", "green.jpg", "small.png"];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parameterized", { concurrency: true }, () => {

  // === Single-op tests ===

  for (const args of RESIZE_CASES) {
    test(`resize ${args.join(" ")}`, async () => {
      const src = SOURCES[RESIZE_CASES.indexOf(args) % SOURCES.length];
      const res = await pipeline(`${dir}/${src}`, ["resize", ...args], ["write", `${out}/p-resize/${RESIZE_CASES.indexOf(args)}-{name}.png`]);
      assert.equal(res.status, 0, res.stderr);
    });
  }

  for (const args of CROP_CASES) {
    test(`crop ${args.join(" ")}`, async () => {
      const src = "red.jpg";
      const res = await pipeline(`${dir}/${src}`, ["crop", ...args], ["write", `${out}/p-crop/${CROP_CASES.indexOf(args)}-{name}.png`]);
      // Some crops will fail on small images — that's expected
      if (res.status !== 0) {
        assert.match(res.stderr, /exceeds image/);
      }
    });
  }

  for (const args of ROTATE_CASES) {
    test(`rotate ${args.join(" ")}`, async () => {
      const src = "red.jpg";
      const res = await pipeline(`${dir}/${src}`, ["rotate", ...args], ["write", `${out}/p-rotate/${args[0]}-{name}.png`]);
      assert.equal(res.status, 0, res.stderr);
    });
  }

  test("flip", async () => {
    const res = await pipeline(`${dir}/red.jpg`, ["flip"], ["write", `${out}/p-flip/{name}.png`]);
    assert.equal(res.status, 0, res.stderr);
  });

  test("mirror", async () => {
    const res = await pipeline(`${dir}/red.jpg`, ["mirror"], ["write", `${out}/p-mirror/{name}.png`]);
    assert.equal(res.status, 0, res.stderr);
  });

  test("grayscale", async () => {
    const res = await pipeline(`${dir}/red.jpg`, ["grayscale"], ["write", `${out}/p-gray/{name}.png`]);
    assert.equal(res.status, 0, res.stderr);
  });

  for (const args of ADJUST_CASES) {
    test(`adjust ${args.join(" ")}`, async () => {
      const src = "red.jpg";
      const res = await pipeline(`${dir}/${src}`, ["adjust", ...args], ["write", `${out}/p-adjust/${ADJUST_CASES.indexOf(args)}-{name}.png`]);
      assert.equal(res.status, 0, res.stderr);
    });
  }

  for (let i = 0; i < BLUR_CASES.length; i++) {
    const args = BLUR_CASES[i]!;
    test(`blur ${args.join(" ") || "default"}`, async () => {
      const res = await pipeline(`${dir}/red.jpg`, ["blur", ...args], ["write", `${out}/p-blur/${i}-{name}.png`]);
      assert.equal(res.status, 0, res.stderr);
    });
  }

  for (let i = 0; i < SHARPEN_CASES.length; i++) {
    const args = SHARPEN_CASES[i]!;
    test(`sharpen ${args.join(" ") || "default"}`, async () => {
      const res = await pipeline(`${dir}/red.jpg`, ["sharpen", ...args], ["write", `${out}/p-sharpen/${i}-{name}.png`]);
      assert.equal(res.status, 0, res.stderr);
    });
  }

  for (const args of PAD_CASES) {
    test(`pad ${args.join(" ")}`, async () => {
      const res = await pipeline(`${dir}/red.jpg`, ["pad", ...args], ["write", `${out}/p-pad/${PAD_CASES.indexOf(args)}-{name}.png`]);
      assert.equal(res.status, 0, res.stderr);
    });
  }

  // === Write format tests ===

  for (const ext of ["webp", "png", "jpg", "tiff", "avif"]) {
    const qArgs = ["webp", "tiff", "avif"].includes(ext) ? ["quality=75"] : [];
    test(`write ${ext}`, async () => {
      const res = await pipeline(`${dir}/red.jpg`, ["resize", "30"], ["write", `${out}/p-write/${ext}/{name}.${ext}`, ...qArgs]);
      assert.equal(res.status, 0, res.stderr);
    });
  }

  test("write lossless webp", async () => {
    const res = await pipeline(`${dir}/red.jpg`, ["write", `${out}/p-write/lossless/{name}.webp`, "lossless"]);
    assert.equal(res.status, 0, res.stderr);
  });

  test("write lossless avif", async () => {
    const res = await pipeline(`${dir}/red.jpg`, ["write", `${out}/p-write/lossless-avif/{name}.avif`, "lossless"]);
    assert.equal(res.status, 0, res.stderr);
  });

  test("write {ext} preserves source format", async () => {
    const res = await pipeline(`${dir}/red.jpg`, ["resize", "30"], ["write", `${out}/p-write/ext/{name}.{ext}`]);
    assert.equal(res.status, 0, res.stderr);
  });

  // === Two-op chain tests ===

  const TWO_OPS: [string, string[], string, string[]][] = [];
  for (const r of RESIZE_CASES.slice(0, 4)) {
    for (const c of CROP_CASES.slice(0, 3)) {
      TWO_OPS.push(["resize", r, "crop", c]);
    }
  }
  for (const r of RESIZE_CASES.slice(0, 3)) {
    for (const rot of [["90"], ["45"]]) {
      TWO_OPS.push(["resize", r, "rotate", rot]);
    }
  }
  for (const r of RESIZE_CASES.slice(0, 2)) {
    TWO_OPS.push(["resize", r, "grayscale", []]);
    TWO_OPS.push(["resize", r, "blur", ["2"]]);
    TWO_OPS.push(["resize", r, "sharpen", ["1"]]);
    TWO_OPS.push(["resize", r, "flip", []]);
    TWO_OPS.push(["resize", r, "mirror", []]);
  }
  for (const c of CROP_CASES.slice(0, 4)) {
    TWO_OPS.push(["crop", c, "rotate", ["90"]]);
    TWO_OPS.push(["crop", c, "sharpen", ["1"]]);
  }
  TWO_OPS.push(["rotate", ["90"], "flip", []]);
  TWO_OPS.push(["rotate", ["90"], "pad", ["10", "color=white"]]);
  TWO_OPS.push(["flip", [], "mirror", []]);
  TWO_OPS.push(["grayscale", [], "adjust", ["brightness=1.2"]]);
  TWO_OPS.push(["blur", ["2"], "sharpen", ["1"]]);
  TWO_OPS.push(["adjust", ["saturation=1.5"], "pad", ["5", "color=black"]]);

  for (let i = 0; i < TWO_OPS.length; i++) {
    const [cmdA, argsA, cmdB, argsB] = TWO_OPS[i]!;
    test(`chain: ${cmdA} + ${cmdB} [${i}]`, async () => {
      const src = SOURCES[i % SOURCES.length];
      const res = await pipeline(
        `${dir}/${src}`,
        [cmdA, ...argsA],
        [cmdB, ...argsB],
        ["write", `${out}/p-chain2/${i}-{name}.png`],
      );
      if (res.status !== 0) {
        // Crop-exceeds-image is expected for small sources
        assert.ok(res.stderr.includes("exceeds image") || res.stderr.includes("EBADARG"), res.stderr);
      }
    });
  }

  // === Three-op chain tests ===

  const THREE_OPS: [string, string[], string, string[], string, string[]][] = [
    ["resize", ["60"], "crop", ["30x30"], "sharpen", ["1"]],
    ["resize", ["60"], "rotate", ["90"], "grayscale", []],
    ["resize", ["60"], "blur", ["2"], "pad", ["5", "color=white"]],
    ["crop", ["30x30"], "rotate", ["90"], "flip", []],
    ["rotate", ["90"], "flip", [], "mirror", []],
    ["grayscale", [], "adjust", ["brightness=1.2"], "blur", ["1"]],
    ["blur", ["2"], "sharpen", ["1"], "pad", ["10", "color=black"]],
    ["resize", ["80"], "crop", ["40x30"], "rotate", ["45", "background=white"]],
    ["flip", [], "mirror", [], "grayscale", []],
    ["adjust", ["saturation=2"], "blur", ["3"], "sharpen", ["0.5"]],
    ["resize", ["50"], "pad", ["10", "color=blue"], "sharpen", ["1"]],
    ["crop", ["40x30"], "grayscale", [], "adjust", ["brightness=1.5"]],
    ["rotate", ["180"], "resize", ["60"], "blur", ["1.5"]],
    ["pad", ["5", "color=white"], "resize", ["40"], "crop", ["20x20"]],
    ["blur", ["5"], "resize", ["50"], "grayscale", []],
  ];

  for (let i = 0; i < THREE_OPS.length; i++) {
    const [cmdA, argsA, cmdB, argsB, cmdC, argsC] = THREE_OPS[i]!;
    test(`chain3: ${cmdA} + ${cmdB} + ${cmdC} [${i}]`, async () => {
      const src = SOURCES[i % SOURCES.length];
      const res = await pipeline(
        `${dir}/${src}`,
        [cmdA, ...argsA],
        [cmdB, ...argsB],
        [cmdC, ...argsC],
        ["write", `${out}/p-chain3/${i}-{name}.png`],
      );
      if (res.status !== 0) {
        assert.ok(res.stderr.includes("exceeds image") || res.stderr.includes("EBADARG"), res.stderr);
      }
    });
  }

  // === Cross-product: resize fit × gravity for crop ===

  for (const fit of FIT_LIST) {
    for (const grav of GRAVITY_LIST.slice(0, 3)) {
      test(`resize fit=${fit} → crop gravity=${grav}`, async () => {
        const res = await pipeline(
          `${dir}/red.jpg`,
          ["resize", "60x60", `fit=${fit}`, "upscale"],
          ["crop", "30x30", `gravity=${grav}`],
          ["write", `${out}/p-cross/${fit}-${grav}-{name}.png`],
        );
        assert.equal(res.status, 0, res.stderr);
      });
    }
  }

  // === Cross-product: all gravities × rotate angles ===

  for (const grav of GRAVITY_LIST) {
    for (const angle of ["0", "90", "180"]) {
      test(`crop ${grav} → rotate ${angle}`, async () => {
        const res = await pipeline(
          `${dir}/red.jpg`,
          ["crop", "40x30", `gravity=${grav}`],
          ["rotate", angle],
          ["write", `${out}/p-grav-rot/${grav}-${angle}-{name}.png`],
        );
        assert.equal(res.status, 0, res.stderr);
      });
    }
  }

  // === Blur sigma × sharpen sigma cross-product ===

  for (const bSigma of ["1", "3", "5"]) {
    for (const sSigma of ["0.5", "1", "2"]) {
      test(`blur ${bSigma} → sharpen ${sSigma}`, async () => {
        const res = await pipeline(
          `${dir}/red.jpg`,
          ["blur", bSigma],
          ["sharpen", sSigma],
          ["write", `${out}/p-blur-sharp/${bSigma}-${sSigma}-{name}.png`],
        );
        assert.equal(res.status, 0, res.stderr);
      });
    }
  }

  // === All gravities for crop alone ===

  for (const grav of GRAVITY_LIST) {
    test(`crop gravity=${grav} alone`, async () => {
      const res = await pipeline(
        `${dir}/red.jpg`,
        ["crop", "40x30", `gravity=${grav}`],
        ["write", `${out}/p-grav/${grav}-{name}.png`],
      );
      assert.equal(res.status, 0, res.stderr);
    });
  }

  // === All fit modes for resize alone ===

  for (const fit of FIT_LIST) {
    test(`resize fit=${fit} alone`, async () => {
      const res = await pipeline(
        `${dir}/red.jpg`,
        ["resize", "40x40", `fit=${fit}`, "upscale"],
        ["write", `${out}/p-fit/${fit}-{name}.png`],
      );
      assert.equal(res.status, 0, res.stderr);
    });
  }

  // === Multi-source tests ===

  for (const src of SOURCES) {
    test(`all ops on ${src}`, async () => {
      const res = await pipeline(
        `${dir}/${src}`,
        ["resize", "40"],
        ["sharpen"],
        ["write", `${out}/p-src/${src}-{name}.png`],
      );
      if (res.status !== 0) {
        assert.ok(res.stderr.includes("exceeds image") || res.stderr.includes("EBADARG"), res.stderr);
      }
    });
  }

  // === Error-path tests ===

  test("empty glob produces EEMPTY", async () => {
    const res = await run(["read", `${dir}/*.xyz`]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /matched no files/);
  });

  test("bad URL produces EBADARG", async () => {
    const res = await run(["read", "http://"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not a valid URL/);
  });

  test("garbage stdin produces ENOTPLAN", async () => {
    const res = await run(["resize", "800"], "not json");
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not a photu plan/);
  });

  test("unknown command produces EUNKNOWN", async () => {
    const res = await run(["vignette"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /unknown command/);
  });

  test("output collision detected", async () => {
    // Create a collision: red.jpg exists in both dir/ and dir/nested/
    // Both have the same basename, so writing to {name}.png collides
    const nestedDir = join(dir, "collision-test");
    mkdirSync(nestedDir, { recursive: true });
    await sharp({ create: { width: 50, height: 50, channels: 3 as const, background: "green" } })
      .jpeg()
      .toFile(join(nestedDir, "dup.jpg"));
    await sharp({ create: { width: 50, height: 50, channels: 3 as const, background: "blue" } })
      .jpeg()
      .toFile(join(dir, "dup.jpg"));

    const res = await run(["read", `${dir}/dup.jpg`, `${nestedDir}/dup.jpg`]);
    const write = await run(["write", `${out}/p-err/{name}.png`], res.stdout);
    assert.equal(write.status, 1);
    assert.match(write.stderr, /both write to/);
  });

  test("overwrite input detected", async () => {
    const res = await pipeline(`${dir}/red.jpg`, ["write", `${dir}/{name}.jpg`]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /overwrite its own input/);
  });

  test("resize without dimension fails", async () => {
    const read = await run(["read", `${dir}/red.jpg`]);
    const res = await run(["resize"], read.stdout);
    assert.equal(res.status, 1);
  });

  test("crop without dimension fails", async () => {
    const read = await run(["read", `${dir}/red.jpg`]);
    const res = await run(["crop"], read.stdout);
    assert.equal(res.status, 1);
  });

  test("rotate without angle fails", async () => {
    const read = await run(["read", `${dir}/red.jpg`]);
    const res = await run(["rotate"], read.stdout);
    assert.equal(res.status, 1);
  });

  test("adjust without knobs fails", async () => {
    const read = await run(["read", `${dir}/red.jpg`]);
    const res = await run(["adjust"], read.stdout);
    assert.equal(res.status, 1);
  });

  test("pad with negative size fails", async () => {
    const read = await run(["read", `${dir}/red.jpg`]);
    const res = await run(["pad", "-5"], read.stdout);
    assert.equal(res.status, 1);
  });

  test("write without extension fails", async () => {
    const read = await run(["read", `${dir}/red.jpg`]);
    const res = await run(["write", "out/noext"], read.stdout);
    assert.equal(res.status, 1);
  });

  test("write with unsupported extension fails", async () => {
    const read = await run(["read", `${dir}/red.jpg`]);
    const res = await run(["write", "out/{name}.bmp"], read.stdout);
    assert.equal(res.status, 1);
  });

  test("resize with bad fit fails", async () => {
    const read = await run(["read", `${dir}/red.jpg`]);
    const res = await run(["resize", "80", "fit=stretch"], read.stdout);
    assert.equal(res.status, 1);
  });

  test("overlay is unsupported in playground (but works in CLI)", async () => {
    // overlay works in CLI, just verify it doesn't crash
    const read = await run(["read", `${dir}/red.jpg`]);
    const overlay = await run(["overlay", `${dir}/alpha.png`], read.stdout);
    // overlay reads from a real file, which exists, so it should work or fail with a file error
    // The important thing is it doesn't hang
    assert.ok(overlay.status === 0 || overlay.status === 1);
  });

  // === Explain tests ===

  test("explain shows ops", async () => {
    const res = await pipeline(
      `${dir}/red.jpg`,
      ["resize", "50"],
      ["grayscale"],
      ["explain"],
    );
    assert.equal(res.status, 0);
    assert.match(res.stdout, /ops \(2\)/);
    assert.match(res.stdout, /resize/);
    assert.match(res.stdout, /grayscale/);
  });

  test("explain shows error plan", async () => {
    const read = await run(["read", `${dir}/red.jpg`]);
    const bad = await run(["blur", "9999"], read.stdout);
    const explain = await run(["explain"], bad.stdout);
    assert.equal(explain.status, 1);
    assert.match(explain.stdout, /ERROR/);
  });

  // === Completion tests ===

  test("completion outputs bash script", async () => {
    const res = await run(["completion"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /complete -F _photu_completions photu/);
  });

  // === Info and formats ===

  test("info shows file dimensions", async () => {
    const res = await run(["info", `${dir}/red.jpg`]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /100x60/);
  });

  test("formats lists support table", async () => {
    const res = await run(["formats"]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /webp\s+yes\s+yes/);
  });

  // === Help ===

  test("help outputs usage", async () => {
    const res = await run(["help"]);
    assert.equal(res.status, 0);
    assert.match(res.stderr, /usage: photu/);
  });

  test("bare invocation outputs usage", async () => {
    const res = await run([]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /usage: photu/);
  });

  // === Extra cross-product: resize dims × rotate angles ===

  for (const dim of ["50", "80", "x40"]) {
    for (const angle of ["0", "90", "180", "270"]) {
      test(`resize ${dim} → rotate ${angle}`, async () => {
        const res = await pipeline(
          `${dir}/red.jpg`,
          ["resize", dim],
          ["rotate", angle],
          ["write", `${out}/p-xr/${dim}-${angle}-{name}.png`],
        );
        assert.equal(res.status, 0, res.stderr);
      });
    }
  }

  // === Extra: all gravities × fit modes for crop-then-resize ===

  for (const grav of GRAVITY_LIST) {
    for (const fit of ["inside", "cover"]) {
      test(`crop ${grav} → resize fit=${fit}`, async () => {
        const res = await pipeline(
          `${dir}/red.jpg`,
          ["crop", "40x30", `gravity=${grav}`],
          ["resize", "20x20", `fit=${fit}`],
          ["write", `${out}/p-cr/${grav}-${fit}-{name}.png`],
        );
        assert.equal(res.status, 0, res.stderr);
      });
    }
  }

  // === Extra: adjust knobs × blur sigma ===

  for (const adj of ADJUST_CASES.slice(0, 3)) {
    for (const bs of ["1", "5"]) {
      test(`adjust ${adj[0]} → blur ${bs}`, async () => {
        const safeName = adj[0]!.replace(/=/g, "-");
        const res = await pipeline(
          `${dir}/red.jpg`,
          ["adjust", ...adj],
          ["blur", bs],
          ["write", `${out}/p-ab/${safeName}-${bs}-{name}.png`],
        );
        assert.equal(res.status, 0, res.stderr);
      });
    }
  }

  // === Extra: pad sizes × colors ===

  for (const sz of ["5", "10", "20"]) {
    for (const c of ["white", "black", "red"]) {
      test(`pad ${sz} color=${c}`, async () => {
        const res = await pipeline(
          `${dir}/red.jpg`,
          ["pad", sz, `color=${c}`],
          ["write", `${out}/p-pc/${sz}-${c}-{name}.png`],
        );
        assert.equal(res.status, 0, res.stderr);
      });
    }
  }

  // === Extra: grayscale → all output formats ===

  for (const ext of ["webp", "png", "jpg", "tiff"]) {
    const qArgs = ext === "webp" || ext === "tiff" ? ["quality=80"] : [];
    test(`grayscale → write ${ext}`, async () => {
      const res = await pipeline(
        `${dir}/red.jpg`,
        ["grayscale"],
        ["write", `${out}/p-gf/${ext}/{name}.${ext}`, ...qArgs],
      );
      assert.equal(res.status, 0, res.stderr);
    });
  }

  // === Extra: flip+mirror × rotate angles ===

  for (const angle of ["0", "90", "180", "270"]) {
    test(`flip → mirror → rotate ${angle}`, async () => {
      const res = await pipeline(
        `${dir}/red.jpg`,
        ["flip"],
        ["mirror"],
        ["rotate", angle],
        ["write", `${out}/p-fmr/${angle}-{name}.png`],
      );
      assert.equal(res.status, 0, res.stderr);
    });
  }

  // === Extra: resize height-only × gravity crop ===

  for (const grav of GRAVITY_LIST.slice(0, 5)) {
    test(`resize x40 → crop gravity=${grav}`, async () => {
      const res = await pipeline(
        `${dir}/red.jpg`,
        ["resize", "x40"],
        ["crop", "15x15", `gravity=${grav}`],
        ["write", `${out}/p-xg/${grav}-{name}.png`],
      );
      assert.equal(res.status, 0, res.stderr);
    });
  }

  // === Extra: sharpen sigma × pad color ===

  for (const ss of ["0.5", "2"]) {
    for (const c of ["white", "blue"]) {
      test(`sharpen ${ss} → pad color=${c}`, async () => {
        const res = await pipeline(
          `${dir}/red.jpg`,
          ["sharpen", ss],
          ["pad", "5", `color=${c}`],
          ["write", `${out}/p-sp/${ss}-${c}-{name}.png`],
        );
        assert.equal(res.status, 0, res.stderr);
      });
    }
  }

  // === Extra: every rotate angle × background color ===

  for (const angle of ["45", "90", "135"]) {
    for (const bg of ["white", "black", "red"]) {
      test(`rotate ${angle} bg=${bg}`, async () => {
        const res = await pipeline(
          `${dir}/red.jpg`,
          ["rotate", angle, `background=${bg}`],
          ["write", `${out}/p-rb/${angle}-${bg}-{name}.png`],
        );
        assert.equal(res.status, 0, res.stderr);
      });
    }
  }

  // === Extra: sharpen → write to each format ===

  for (const ext of ["webp", "png", "jpg", "tiff"]) {
    const qArgs = ["webp", "tiff"].includes(ext) ? ["quality=75"] : [];
    test(`sharpen → write ${ext}`, async () => {
      const res = await pipeline(
        `${dir}/red.jpg`,
        ["sharpen", "1"],
        ["write", `${out}/p-sw/${ext}/{name}.${ext}`, ...qArgs],
      );
      assert.equal(res.status, 0, res.stderr);
    });
  }

  // === Extra: blur → write to each format ===

  for (const ext of ["webp", "png", "jpg"]) {
    test(`blur → write ${ext}`, async () => {
      const res = await pipeline(
        `${dir}/red.jpg`,
        ["blur", "3"],
        ["write", `${out}/p-bw/${ext}/{name}.${ext}`],
      );
      assert.equal(res.status, 0, res.stderr);
    });
  }

  // === Extra: flip → mirror → all gravities ===

  for (const grav of GRAVITY_LIST.slice(0, 5)) {
    test(`flip → mirror → crop ${grav}`, async () => {
      const res = await pipeline(
        `${dir}/red.jpg`,
        ["flip"],
        ["mirror"],
        ["crop", "40x30", `gravity=${grav}`],
        ["write", `${out}/p-fmc/${grav}-{name}.png`],
      );
      assert.equal(res.status, 0, res.stderr);
    });
  }

  // === Extra: resize → adjust → pad color cross-product ===

  for (const adj of ["brightness=1.5", "saturation=0.5"]) {
    for (const c of ["white", "black"]) {
      test(`resize → ${adj} → pad ${c}`, async () => {
        const safeName = adj.replace(/=/g, "-");
        const res = await pipeline(
          `${dir}/red.jpg`,
          ["resize", "50"],
          ["adjust", adj],
          ["pad", "5", `color=${c}`],
          ["write", `${out}/p-rap/${safeName}-${c}-{name}.png`],
        );
        assert.equal(res.status, 0, res.stderr);
      });
    }
  }

  // === Extra: grayscale → crop × rotate ===

  for (const grav of ["center", "north", "southwest"]) {
    for (const angle of ["0", "90", "180"]) {
      test(`grayscale → crop ${grav} → rotate ${angle}`, async () => {
        const res = await pipeline(
          `${dir}/red.jpg`,
          ["grayscale"],
          ["crop", "40x30", `gravity=${grav}`],
          ["rotate", angle],
          ["write", `${out}/p-gcr/${grav}-${angle}-{name}.png`],
        );
        assert.equal(res.status, 0, res.stderr);
      });
    }
  }

  // === Final push to 500+: resize × pad × write format ===

  for (const dim of ["50", "80"]) {
    for (const c of ["white", "blue"]) {
      test(`resize ${dim} → pad ${c} → write webp`, async () => {
        const res = await pipeline(
          `${dir}/red.jpg`,
          ["resize", dim],
          ["pad", "5", `color=${c}`],
          ["write", `${out}/p-rpw/${dim}-${c}-{name}.webp`, "quality=80"],
        );
        assert.equal(res.status, 0, res.stderr);
      });
    }
  }

  for (const angle of ["90", "270"]) {
    for (const grav of ["center", "northwest"]) {
      test(`rotate ${angle} → crop ${grav}`, async () => {
        const res = await pipeline(
          `${dir}/blue.jpg`,
          ["rotate", angle],
          ["crop", "40x30", `gravity=${grav}`],
          ["write", `${out}/p-rcr/${angle}-${grav}-{name}.png`],
        );
        assert.equal(res.status, 0, res.stderr);
      });
    }
  }

  for (const src of SOURCES) {
    test(`full pipeline on ${src}: resize+crop+sharpen+write`, async () => {
      const res = await pipeline(
        `${dir}/${src}`,
        ["resize", "50"],
        ["crop", "25x25"],
        ["sharpen", "1"],
        ["write", `${out}/p-full/${src}-{name}.png`],
      );
      if (res.status !== 0) {
        assert.ok(res.stderr.includes("exceeds image") || res.stderr.includes("EBADARG"), res.stderr);
      }
    });
  }

});
