# Issue triage

This repository is a public mirror. This guide is for both reporters and maintainers: reporters can use public issues to report problems and ask questions, while maintainers use the intake, response, and resolution rules below. Changes, when published, come from the producing source rather than direct edits to mirrored files.

Suspected security vulnerabilities do not belong in public issues. Do not post exploit details publicly; use the private reporting process in the [security policy](SECURITY.md).

## Intake

For every new issue:

1. Confirm that the report concerns the SDK, the protocol declarations, or the published documentation.
2. Classify it as a bug, documentation problem, question, or feature request.
3. If it may describe a security vulnerability, stop public triage and direct the reporter to the private process in the [security policy](SECURITY.md). Do not ask for exploit details in the public thread.
4. Ask only for information needed to reproduce or understand the report. Useful details include the package version or commit, runtime version, operating system, a minimal example, the observed result, and the expected result.
5. Remove or ask the reporter to remove secrets, credentials, private links, personal data, and non-public logs. Public issues must contain only information that can be shared publicly. Treat any credential posted publicly as compromised: ask the reporter to revoke or rotate it immediately, even if the public text is edited or deleted.
6. Check for an existing issue that describes the same behavior before treating the issue as a separate report.

If the behavior may be intentional, say that it **may be expected** until the public specification or documentation confirms otherwise. Do not present a hypothesis as a verified defect. “Not implemented” is not the same as “by design.”

## Responses

A response should be useful without access to private systems:

- Link only to public documentation, public source, or public issues.
- Do not expose private implementation details, identifiers, discussions, or change links.
- Do not promise a fix or delivery date.
- When a fix is available, name the first public release that contains it and any action the user must take.
- If no public resolution is available yet, say that the report has been received and avoid implying a schedule.
- If behavior is intended but the public documentation does not explain it, describe the behavior plainly on the issue and track the missing explanation as a documentation problem.

## Resolution

Maintainers make duplicate and close decisions. A feature request stays open until a maintainer accepts or declines it.

Close an issue only when one of these is true:

- a public release containing the fix is available;
- public documentation now answers the question;
- the behavior is confirmed by the public contract, the explanation is recorded on the issue, and any missing public explanation is tracked as a documentation problem;
- the issue is a verified duplicate with a public canonical issue;
- the reporter confirms that the problem is resolved or no longer applicable;
- a maintainer declines a feature request and records the reason on the issue;
- the report is out of scope and the closing comment records why, with a public destination when one is known; or
- the problem cannot be reproduced or lacks required information after one specific follow-up request and at least 14 days without a reply. The closing comment must state what information would allow the issue to be reopened.

A duplicate means the same behavior in the same component with the same trigger; a similar title is not enough. The older issue is normally canonical unless the newer issue contains better public evidence.

A closing comment should quote or link the relevant public evidence. For a fixed issue, verify and name the public release. For a duplicate, link the canonical issue. For any closure that could change with new evidence, tell the reporter what would justify reopening the issue.

Never use a private change or private tracker as the reader-facing proof.

## Mirror boundaries

Most files in this repository are generated or mirrored and are not edited here. Follow `publish-anchor.json`: only paths listed under `repo_meta.hand_authored` may be maintained directly in this repository. Changes to mirrored SDK, protocol, examples, tests, or generated documentation must be made in their producing source and republished.
