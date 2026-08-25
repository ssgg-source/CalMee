import { describe, expect, test } from "bun:test";
import {
  compactStoredTranscripts,
  getStoredTranscriptSequenceId,
  type StoredTranscript,
} from "../../src/services/indexedDBService";

const revision = (
  sequenceId: number,
  text: string,
  storedAt: number,
  useLegacyField = false,
): StoredTranscript => ({
  meetingId: "recovery-fixture",
  text,
  timestamp: "00:00:00",
  confidence: 0.9,
  storedAt,
  ...(useLegacyField ? { sequence_id: sequenceId } : { sequenceId }),
});

describe("IndexedDB transcript recovery compaction", () => {
  test("keeps only the latest live revision for each sequence", () => {
    const compacted = compactStoredTranscripts([
      revision(4, "第一版", 10, true),
      revision(4, "第一版继续增长", 20, true),
      revision(5, "下一段", 30),
    ]);

    expect(compacted.map(item => item.text)).toEqual(["第一版继续增长", "下一段"]);
    expect(compacted.map(item => item.sequenceId)).toEqual([4, 5]);
  });

  test("preserves sequence zero instead of replacing it with a fallback", () => {
    expect(getStoredTranscriptSequenceId(revision(0, "开头", 1), 99)).toBe(0);
  });
});
