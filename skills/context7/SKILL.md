---
name: context7
description: Fetch up-to-date documentation and code examples for any library or framework using the Context7 API. Use this skill whenever you need current docs, API references, code snippets, migration guides, or usage examples for a specific package, library, or framework. Triggers on 'how to use X', 'X documentation', 'look up docs for', 'API reference for', 'how does X work', 'example of X', 'X tutorial', 'X migration guide', 'latest docs for', 'check the docs', or any task where you need accurate, version-specific documentation for a library, SDK, framework, or package. Especially useful when the user asks about library features, configuration options, or best practices that may have changed in recent versions.
---

# Context7 — Up-to-date Library Documentation

This skill fetches current documentation and code examples for any programming library or framework via the Context7 REST API, called directly through `bash`.

Context7 indexes documentation from official sources and provides version-specific, relevant excerpts — much more reliable than relying on potentially outdated training data.

## Two-step workflow

### Step 1: Resolve the library ID

Before fetching docs, you need the Context7-compatible library ID for the package:

```bash
bash <SKILL_DIR>/scripts/context7.sh resolve "Library Name" "what you need help with"
```

This returns a list of matching libraries with:
- **Library ID** — the identifier you need for step 2 (format: `/org/project`)
- **Name** — human-readable name
- **Description** — short summary
- **Code Snippets** — how many examples are available
- **Source Reputation** — authority level (High/Medium/Low)
- **Benchmark Score** — quality indicator (100 = best)
- **Versions** — available versions if you need a specific one

Pick the library with the best name match, highest reputation, and most snippets. If the user specified a version, use it (format: `/org/project/version`).

### Step 2: Query documentation

```bash
bash <SKILL_DIR>/scripts/context7.sh docs "/org/project" "specific question or topic"
```

Returns relevant documentation sections with code examples and source links.

`<SKILL_DIR>` is the directory containing this SKILL.md file.

## Best practices

1. **Be specific with queries.** "How to set up authentication with JWT in Express.js" is much better than "auth". The more specific, the more relevant the results.

2. **Resolve once, query multiple times.** If researching a broad topic, resolve the library ID once, then make 2-3 focused queries with different aspects.

3. **Don't over-call.** Limit to 3 calls per question total (resolve + docs). If you can't find what you need in 3 calls, work with the best result you have.

4. **Use versions when specified.** If the user mentions a specific version ("Next.js 15", "React 19"), pass it as part of the library ID: `/vercel/next.js/v16.0.3`.

5. **Present the code examples.** Context7 returns actual code from official docs. Show the relevant snippets to the user, along with explanations.

6. **Cite sources.** Each documentation section includes a source URL. Reference it when presenting information.

## Example usage

```bash
# Step 1: Find the library
bash /path/to/scripts/context7.sh resolve "Tailwind CSS" "how to use flexbox utilities"

# Step 2: Get docs (using the library ID from step 1)
bash /path/to/scripts/context7.sh docs "/tailwindlabs/tailwindcss" "flexbox grid layout examples"

# With a specific version
bash /path/to/scripts/context7.sh resolve "Next.js" "App Router"
bash /path/to/scripts/context7.sh docs "/vercel/next.js/v16.0.3" "server components setup"
```
