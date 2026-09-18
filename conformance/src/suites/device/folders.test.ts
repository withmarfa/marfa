import { describe, it } from "vitest";
import { notWrittenYet, skipIfPending } from "./pending.js";

/**
 * "A folder is a view on a slice."
 *
 * Three of the rules below are refusals and the rest are identities, and each
 * exists because its absence is silent. A create that carries no version
 * replaces newer server content and reports success. Two identity rules on
 * the two push paths turn one file into two items depending on when it
 * appeared. A natural key that differs per credential does the same across two
 * machines. None of the three raises anything anywhere, which is why each is
 * written as a rule the folder either keeps or refuses to act.
 */

describe("what a folder is", () => {
  it("is a view on a slice with defaults for a new file", (context) => {
    skipIfPending(context);
    notWrittenYet("a folder's slice and its defaults");
  });

  it("keeps each folder's state and queue to itself", (context) => {
    skipIfPending(context);
    notWrittenYet("several folders on one machine");
  });

  it("hydrates into an empty directory and pushes without holding anything else", (context) => {
    skipIfPending(context);
    notWrittenYet("a folder in a container");
  });
});

describe("files and items", () => {
  it("makes a file an item and an item a file", (context) => {
    skipIfPending(context);
    notWrittenYet("a file as an item");
  });

  it("carries frontmatter to properties and the body to the body", (context) => {
    skipIfPending(context);
    notWrittenYet("frontmatter and the body");
  });

  it("treats a body opening with a horizontal rule as a body", (context) => {
    skipIfPending(context);
    notWrittenYet("a body that opens with a horizontal rule");
  });

  it("carries links to edges and edges to links", (context) => {
    skipIfPending(context);
    notWrittenYet("links as edges");
  });
});

describe("identity", () => {
  it("follows a rename by device, inode and birth time", (context) => {
    skipIfPending(context);
    notWrittenYet("rename identity");
  });

  it("treats a file with no usable identity as new rather than guessing", (context) => {
    skipIfPending(context);
    notWrittenYet("a file with no usable identity");
  });

  it("binds the same file to the same item whether it was present at start or arrived while running", (context) => {
    skipIfPending(context);
    notWrittenYet("one identity rule on both push paths");
  });

  it("binds one file to one item across two separately enrolled devices", (context) => {
    skipIfPending(context);
    notWrittenYet("a natural key two devices share");
  });

  it("keeps the item id in the file as a record, and does not depend on it for identity", (context) => {
    skipIfPending(context);
    notWrittenYet("the item id a folder writes back");
  });

  it("moves the file when the item is renamed on the server", (context) => {
    skipIfPending(context);
    notWrittenYet("a rename made on the server");
  });
});

describe("writing", () => {
  it("refuses a create that carries no version", (context) => {
    skipIfPending(context);
    notWrittenYet("a version-less create");
  });

  it("does not overwrite newer server content from a stale folder", (context) => {
    skipIfPending(context);
    notWrittenYet("a stale folder meeting newer content");
  });

  it("does not read its own writes back as changes", (context) => {
    skipIfPending(context);
    notWrittenYet("echo suppression");
  });

  it("defers a delete past the rename grace", (context) => {
    skipIfPending(context);
    notWrittenYet("a deferred delete");
  });

  it("journals a delete that happened while it was not running", (context) => {
    skipIfPending(context);
    notWrittenYet("an offline delete");
  });
});

describe("what a folder does not watch", () => {
  it("excludes a dot-led directory at any depth", (context) => {
    skipIfPending(context);
    notWrittenYet("a dot-led directory");
  });

  it("keeps its own state in .marfa and never pushes it", (context) => {
    skipIfPending(context);
    notWrittenYet("the folder's own state");
  });

  it("leaves a file outside the slice alone", (context) => {
    skipIfPending(context);
    notWrittenYet("a file outside the slice");
  });
});
