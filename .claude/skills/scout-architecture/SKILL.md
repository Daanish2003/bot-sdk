---
name: scout-architecture
description: Research how a new feature or idea could be built, draw the candidate architectures, and pick a direction before grilling or wayfinding.
argument-hint: "<the feature or idea>"
disable-model-invocation: true
---

An idea has arrived and the user wants to see how it could work before committing to the full planning cycle. You are the **scout**: go ahead of the main party, research the terrain, and come back with a **scout report**, a cited picture of the viable routes and a recommendation. Reversible impressions, not commitments: `/grill-with-docs` or `/wayfinder` may overturn any of it later.

Research is your job. The user's job is to react to what you found and choose a direction.

## 1. Frame

Restate the idea in two sentences and name its **main scenario**: the one concrete journey, trigger to outcome, that the feature exists for. Ask only for what the argument leaves unclear, and move on as soon as the scenario is confirmed.

Done when: the user has confirmed the scenario.

## 2. Survey the codebase

Dispatch a subagent to read the domain docs, the ADRs, and the code the idea touches. It returns the modules involved (with paths), the seams a feature could attach to, and every ADR that constrains the idea, with its status.

Done when: every box you will later draw as existing has a real path behind it.

## 3. Research

Split the idea into its **research questions**: the handful whose answers would change the architecture. Dispatch one subagent per question, in parallel. Give each this brief:

- **Prior art**: how two or three mature projects or products solve this. Prefer their source code, official docs, and first-party engineering writing.
- **Named patterns**: the established name for each approach and the catalog it comes from (for example _Patterns of Enterprise Application Architecture_, _Enterprise Integration Patterns_, microservices.io), so the user can look it up.
- **Books**: what the standard texts say (for example _Designing Data-Intensive Applications_, _Release It!_). Cite a book's title and chapter only after a search has confirmed them; label anything else `from memory`.
- **Failure modes**: how this approach breaks in production, from postmortems and issue trackers.
- **Return**: under 300 words, each claim with its link, each conflict between sources stated.

Done when: every research question has a cited answer or is marked unanswered, and each source's date is noted where the field moves fast.

## 4. Draw the routes

Present two or three **routes**: architectures that differ in shape, such as where the state lives or what owns the flow. Variations of one design count as one route. For each route, show:

- **A diagram** in a code block, at most 80 columns wide, marking boxes `new` or by existing path and labelling each arrow with what crosses it.
- **The main scenario** walked through it, step by step.
- **One failure**: the most likely thing to go wrong and what the user would see.
- **The pattern** it is an instance of, with its sources.
- **The cost**: what it makes harder later, and any ADR it contradicts.

End with your recommended route and why.

Done when: every claim about how a route behaves in the wild has a source or a `from memory` label.

## 5. Choose

Call the Skill tool with "mattpocock-skills:grilling" and run it over the **load-bearing** decisions only: those where each answer would redraw the diagram. Every other question goes in the report as **fog**, for the full cycle to clear. "Frontier empty" here means no load-bearing decision is left open.

Redraw the chosen route after each round so the user sees what their answers changed. Send a new research subagent when an answer opens a new research question.

More than three rounds of load-bearing decisions is itself a finding: the idea needs `/wayfinder`. Say so and go to step 6 with the rest as open.

Done when: the user has chosen a route or dropped the idea, and can see how the chosen route works from the final diagram.

## 6. Write the scout report

Save it where the repo keeps research notes (`docs/research/<slug>-scout.md` if that folder exists), then give the user the path. Leave it uncommitted and write no ADRs: decisions become ADRs in the full cycle.

```markdown
# Scout report: <idea>

Status: provisional. A starting point for grilling, not a decision.

## The idea

<two sentences and the main scenario>

## Chosen route

<diagram, walkthrough, failure>

## Routes not taken

<one line each: the route and why it lost>

## Load-bearing decisions

<decision, then the answer or `open`>

## Constraints

<modules and ADRs that shape this, with paths>

## Fog

<questions left for the full cycle>

## Sources

<links and books, with what each supports>

## Next step

<one of the verdicts below, and why>
```

Pick one verdict:

- **Build it**: small and clear, go to `implement` or `tdd`.
- **`prototype`**: only running code can settle what is left.
- **`/grill-with-docs`**: fits one effort, but details remain open.
- **`/wayfinder`**: too big for one session, or several decisions still open.
- **Drop it**: the research shows the cost outweighs the value.

If the diagram outgrows the terminal or the user wants to view or share it, load `artifact-diagramming` and publish the report as an Artifact.

Done when: the file exists and names one verdict.
