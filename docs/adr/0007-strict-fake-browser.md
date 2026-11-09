# Test against a strict fake browser

Unit tests use an in-memory browser (`tests/helpers/fake-browser.ts`) that rejects calls the
way real browsers do, instead of a permissive mock that accepts anything. For example, it
refuses `tabs.group` with a top-level `windowId`, as Chrome does; a bug of exactly that kind
shipped in the original extension. When a test needs behaviour the fake doesn't model, the rule
is added to the fake, not loosened in the test.
