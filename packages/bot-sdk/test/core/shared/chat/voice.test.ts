import { describe, expect, it } from "vitest";

import { dictationAudioType, isDictationAudioType } from "../../../../plugins/models/shared/voice";

describe("dictation audio types", () => {
  it("drops the codec parameters from a recorder's type", () => {
    expect(dictationAudioType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(dictationAudioType("Audio/MP4 ")).toBe("audio/mp4");
  });

  it.each([
    "audio/webm;codecs=opus",
    "audio/ogg",
    "audio/mp4",
    "audio/m4a",
    "audio/mpeg",
    "audio/wav",
  ])("accepts %s", (mimeType) => {
    expect(isDictationAudioType(mimeType)).toBe(true);
  });

  it.each(["video/webm", "audio/flac", "", "text/plain"])("refuses %j", (mimeType) => {
    expect(isDictationAudioType(mimeType)).toBe(false);
  });
});
