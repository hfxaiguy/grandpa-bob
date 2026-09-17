# Taste

- Keeps test files co-located with the source/pattern files they cover (same directory, `*.test.mjs` naming) rather than in a separate test folder, and expects related docs/notation files to live alongside them too. Confidence: 0.65
- Wants companion docs/specs to share the base filename of the artifact they document (e.g. `person-scan.md` alongside `person-scan.mjs`) rather than a generic name like `notation.md`, and expects in-file references to be updated to match the rename. Confidence: 0.75
- When co-located tests exist, wants runtime file discovery (e.g. glob-based loaders, dropdown/registry listings) to explicitly skip test files so they are never surfaced or executed as real artifacts — fixed in the loader, not by relocating the tests. Confidence: 0.7
- Expects every code change to be accompanied by tests, and those tests to actually be run to verify they pass — treat writing and running tests as a mandatory part of the task, not an optional follow-up. Confidence: 0.9
- Wants auxiliary UI panels (side panels/drawers for structure, logs, live progress) to stay visible alongside the main view by default rather than hidden behind a toggle — keep them open, non-modal/non-blocking so the primary content stays usable, and preserve that open state across reloads. Confidence: 0.6
- Always write tests for code changes, and run them to verify they pass. Confidence: 0.9
