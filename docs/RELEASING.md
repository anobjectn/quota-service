# Release process

This project uses Semantic Versioning, annotated Git tags, and GitHub Releases.
There is no `CHANGELOG.md`; the GitHub Release notes are the canonical changelog
and are written from the commit range. The version string is duplicated in a few
source locations and every copy must match the release tag. There is no
package-registry publication step and no automated release workflow.

## Version locations

A release bumps the version in **four** places, all of which must agree:

- `package.json` — `"version"`.
- `src/mcp.ts` — the `McpServer` `version` field.
- `src/collectors/codex.ts` — both `User-Agent: "quota-service/<version> (+codex-cli-compatible)"` strings.

Before editing, confirm the current set:

```bash
grep -rn '"version"\|version:\|quota-service/' package.json src/mcp.ts src/collectors/codex.ts
```

## Invocation and approval model

Repository-local `release-quota-service` skills expose this process to
Codex-compatible agents from `.agents/skills/` and Claude Code from
`.claude/skills/`. A user may start it with natural language such as:

- "Let's make a new release now."
- "What version should the next release be?"
- "Release 1.2.0."
- "Let's make a new release using our release skill."

Codex can also invoke `$release-quota-service`; Claude Code can invoke
`/release-quota-service`.

The initial request starts a read-only preparation phase. The agent recommends
or validates the version, drafts the GitHub Release notes, lists the included
changes and planned mutations, then pauses for review. It must not edit release
files, commit, tag, push, or publish during preparation.

The review bundle must contain:

- the recommended or requested version and its rationale;
- the included commit range and categorized change summary;
- the exact proposed GitHub Release notes;
- breaking changes, migrations, and upgrade notes, explicitly saying when there
  are none;
- the verification commands and release mutations that execution will perform.

Execution begins only after the user explicitly approves this complete bundle
and its exact version. If any detail changes, the agent must present the revised
bundle and obtain approval again.

## Agent guardrails

An agent performing a release must:

- Recommend a Semantic Version when none is supplied: major for breaking
  changes, minor for backward-compatible features, and patch for fixes only.
  The `/usage` wire contract is a consumed API surface; a
  backward-incompatible change to it is a major bump.
- Never execute until the user explicitly approves the exact target version and
  complete review bundle.
- Release only from `main`, with a clean working tree that matches
  `origin/main` (feature commits may be locally ahead and will be published by
  the release push, but there must be no divergence and no unrelated
  uncommitted changes).
- Use `git-identity-routing` before the release commit.
- Use `github-account-routing` before any GitHub CLI or API action.
- Stop if identity routing is unmapped or mismatched, the branch has diverged,
  the target tag already exists locally or remotely, verification fails, or
  release scope is unclear.
- Never move or reuse a published tag. Correct a released defect with a new
  patch release.

The named routing skills may not exist in every agent client. Regardless of
client, enforce their project mappings:

- Origin host `github.com`: commit as
  `Luis Ortiz <2839770+anobjectn@users.noreply.github.com>` and use GitHub CLI
  account `anobjectn`.
- Origin host `github.com-troyweb`: commit as
  `Luis Ortiz <luis.ortiz@troyweb.com>` and use GitHub CLI account
  `anobjectw`.

Read the origin rather than inferring from repository or organization names.
Stop and ask if the origin host is absent or unmapped. Verify `git config
user.name` and `git config user.email` immediately before committing. Before
GitHub CLI writes, verify `gh auth status --hostname github.com` and switch to
the mapped account only if needed.

## 1. Confirm the target

Fetch tags and inspect the current release:

```bash
git fetch origin --tags
git tag --sort=-version:refname | head -1
git show --no-patch --format='%H %s' HEAD
git status --short --branch
git rev-list --left-right --count main...origin/main
```

Confirm all of the following before editing:

- The user explicitly approved the exact target version and review bundle.
- All four version locations match the latest `v<version>` tag.
- `main` has not diverged from `origin/main` (right-side count is `0`).
- The working tree has no unrelated changes.
- Neither `git tag --list 'v<target>'` nor
  `git ls-remote --tags origin 'refs/tags/v<target>'` returns a tag.

For example, the minor release after `v1.1.0` is `1.2.0`, tagged `v1.2.0`.

## 2. Draft the release notes

Review every first-parent commit since the latest release:

```bash
git log --first-parent --reverse --format='%h %s' v<current>..HEAD
git diff --stat v<current>..HEAD
```

Draft concise GitHub Release notes from the commit range, using these headings
when applicable:

- Highlights
- Fixes
- Upgrade notes

Describe user-visible outcomes, not a raw commit list. Note that `/usage`
contract changes are typically additive; state explicitly when a consumer such
as ai-usage-observatory is unaffected. Mention breaking changes, migrations, or
new configuration (for example `QUOTA_RETENTION_DAYS`) explicitly. Omit empty
sections. Match the established title style: `v<target> — <short description>`.
Show the draft to the user and obtain approval before committing, tagging,
pushing, or publishing.

## 3. Prepare and verify

Set the approved version in all four locations (see "Version locations"). Then
run the complete verification suite:

```bash
bun run typecheck
bun test
git diff --check
```

If any command fails, stop and report the failure. Do not tag or publish a
partially verified release.

Review the final release diff and confirm it contains only the intended version
changes:

```bash
git diff -- package.json src/mcp.ts src/collectors/codex.ts
git status --short
```

## 4. Commit and tag

After applying `git-identity-routing`, stage the version changes and create the
release commit using Conventional Commit format:

```bash
git add package.json src/mcp.ts src/collectors/codex.ts
git commit -m "chore(release): v<target>"
```

Confirm the commit identity and contents, then create an annotated tag:

```bash
git show --no-patch --format=fuller HEAD
git show --stat --oneline HEAD
git tag -a "v<target>" -m "v<target>"
git show --no-patch "v<target>"
```

## 5. Push and publish

Push the release commit first, then its tag:

```bash
git push origin main
git push origin "v<target>"
```

After applying `github-account-routing`, publish the approved notes as a
non-draft GitHub Release for the existing tag. Prefer a notes file so shell
quoting cannot alter the content:

```bash
gh release create "v<target>" --verify-tag --title "v<target> — <short description>" --notes-file /absolute/path/to/approved-release-notes.md
```

Do not use automatically generated notes unless the user explicitly chooses
them instead of the reviewed notes.

## 6. Verify the published release

Verify all release surfaces before reporting completion:

```bash
git status --short --branch
git ls-remote --tags origin "refs/tags/v<target>"
gh release view "v<target>"
```

Report the release commit, tag, GitHub Release URL, verification results, and
any intentionally omitted steps.

## Starting a release

No procedural prompt is required. Ask for a release naturally, optionally with
an exact version. The repository skills supply the same process in Codex and
Claude Code and always pause at the review gate before execution.
