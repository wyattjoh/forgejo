import packageJson from "../package.json";

/** The installed Forgejo CLI package version exposed through Request metadata. */
export const cliVersion = packageJson.version;

/**
 * Where a binary came from, and the commit it was built on.
 *
 * `scripts/build-release.sh` replaces both readings at compile time through `bun build --define`,
 * so a built binary carries its own provenance rather than inferring it from the tree it happens
 * to sit next to. A tree run straight from source defines neither and reads ordinary undefined
 * environment values, which is the `source` case.
 *
 * The commit matters because the package version alone cannot distinguish two builds cut from the
 * same unreleased version, which is exactly when a stale install looks current.
 */
const buildCommit = process.env.FORGEJO_BUILD_COMMIT;
const buildSource = process.env.FORGEJO_BUILD_SOURCE;

/** Provenance for the running binary, reported by `--version` in both modes. */
export type BuildStamp = {
  commit: string | null;
  source: "release" | "dev" | "source";
};

export const buildStamp: BuildStamp = {
  commit: buildCommit && buildCommit.length > 0 ? buildCommit : null,
  source: buildSource === "release" ? "release" : buildCommit ? "dev" : "source",
};

/**
 * Renders the one line Human mode prints for `--version`.
 *
 * A release build states its version alone, since the tag already identifies the commit. Any other
 * build names its origin and commit, so a bug report from an unreleased binary is traceable.
 */
export function versionLine(): string {
  if (buildStamp.source === "release") return `forgejo ${cliVersion}`;
  if (buildStamp.commit)
    return `forgejo ${cliVersion} (${buildStamp.source}, ${buildStamp.commit})`;
  return `forgejo ${cliVersion} (${buildStamp.source})`;
}
