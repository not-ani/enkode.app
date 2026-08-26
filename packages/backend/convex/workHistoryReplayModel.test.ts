import { describe, expect, it } from "vitest";

import { reconstructReplayFrames } from "./workHistoryReplayModel";

describe("Work History replay reconstruction", () => {
  it("reconstructs exact multi-file state at representative sequence points", () => {
    const frames = reconstructReplayFrames(
      [],
      [
        {
          sequence: 1,
          type: "workspace_state",
          files: [
            { path: "main.py", content: "print(message)\n" },
            { path: "message.py", content: "message = 'hello'\n" },
          ],
          observedAt: 1,
        },
        {
          sequence: 2,
          type: "file_change",
          path: "message.py",
          changes: [{ rangeOffset: 10, rangeLength: 7, text: "'hi'" }],
          origin: "paste",
          observedAt: 2,
        },
        {
          sequence: 3,
          type: "file_change",
          path: "main.py",
          changes: [{ rangeOffset: 0, rangeLength: 0, text: "from message import message\n" }],
          origin: "completion",
          observedAt: 3,
        },
      ],
    );

    expect(frames[0]!.files).toEqual([
      { path: "main.py", content: "print(message)\n" },
      { path: "message.py", content: "message = 'hello'\n" },
    ]);
    expect(frames[1]!.files[1]!.content).toBe("message = 'hi'\n");
    expect(frames[2]!.files[0]!.content).toBe("from message import message\nprint(message)\n");
    expect(frames.map(({ event }) => event.type === "file_change" && event.origin)).toEqual([
      false,
      "paste",
      "completion",
    ]);
  });

  it("continues reconstruction from a prior page baseline", () => {
    const frames = reconstructReplayFrames(
      [{ path: "main.py", content: "one\n" }],
      [
        {
          sequence: 101,
          type: "file_change",
          path: "main.py",
          changes: [{ rangeOffset: 0, rangeLength: 3, text: "two" }],
          origin: "typing",
          observedAt: 101,
        },
      ],
    );
    expect(frames[0]).toMatchObject({
      sequence: 101,
      files: [{ path: "main.py", content: "two\n" }],
    });
  });
});
