import { describe, expect, it } from "vitest";
import { DeepgramProvider } from "../src/providers/deepgram.js";
import { SerialQueue } from "../src/util/backoff.js";

describe("DeepgramProvider.buildUrl", () => {
  const base = { language: "en", endpointingMs: 600, keywords: [{ term: "Eucharist", boost: 3 }, { term: "Imam" }] };

  it("uses keyterm prompting on nova-3", () => {
    const url = new URL(new DeepgramProvider("k", "nova-3").buildUrl(base));
    expect(url.searchParams.getAll("keyterm")).toEqual(["Eucharist", "Imam"]);
    expect(url.searchParams.get("endpointing")).toBe("600");
    expect(url.searchParams.get("interim_results")).toBe("true");
    expect(url.searchParams.has("encoding")).toBe(false);
  });

  it("uses keyword boosting on older models and sets PCM params", () => {
    const url = new URL(new DeepgramProvider("k", "nova-2").buildUrl({ ...base, encoding: "linear16", sampleRate: 16000 }));
    expect(url.searchParams.getAll("keywords")).toEqual(["Eucharist:3", "Imam:2"]);
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
  });
});

describe("SerialQueue", () => {
  it("delivers in submission order even when work finishes out of order", async () => {
    const q = new SerialQueue();
    const out: number[] = [];
    const delayed = (n: number, ms: number) => new Promise<number>((r) => setTimeout(() => r(n), ms));
    const a = delayed(1, 30);
    const b = delayed(2, 5);
    await Promise.all([q.push(async () => void out.push(await a)), q.push(async () => void out.push(await b))]);
    expect(out).toEqual([1, 2]);
  });
});
