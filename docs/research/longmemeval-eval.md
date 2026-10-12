# LongMemEval for a small Memory eval

Research for issue #218 (child of the map #215). Researched on 2026-10-12.

**Question.** How do we build a small LongMemEval-style eval for Memory: the dataset's format, licence, size and variants, its question types, how it scores answers, and how to pick 30–50 cases for a hand-run script against the real Background Model? Is LoCoMo a better fit? May the data be vendored?

**Sources.** The LongMemEval paper ([arXiv 2410.10813](https://arxiv.org/abs/2410.10813), ICLR 2025); the repo [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) at `main` (README, `src/evaluation/evaluate_qa.py`, `print_qa_metrics.py`); the Hugging Face dataset [xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned) at revision `98d7416c24c778c2fee6e6f3006e7a073259d48f`; the LoCoMo repo [snap-research/locomo](https://github.com/snap-research/locomo) (README, `LICENSE.txt`, `data/locomo10.json`, `task_eval/evaluation.py`). Numbers marked _measured_ were computed by downloading `longmemeval_oracle.json` and `longmemeval_s_cleaned.json` from that revision and counting.

---

## Recommendation

- **Use LongMemEval, not LoCoMo.** Its histories are user–assistant chats with facts about _the user_, which is exactly what Memory extracts. LoCoMo is two personas talking to each other, is scored by token F1, and is CC BY-NC 4.0.
- **Pick 40 cases from `longmemeval_s_cleaned.json`, stratified by type** (quota below), and feed each case a trimmed history: its evidence sessions plus the first 8 filler sessions from its own haystack, in timestamp order. Full S (about 48 sessions per case) costs about 10× more and needs about 10,000 extraction calls; oracle (evidence only) has no distractors, so it never tests whether extraction ignores noise.
- **Ingest each user/assistant pair as one finished Run** with the session's timestamp as "now", calling `save` after each. Don't regenerate assistant replies: `single-session-assistant` questions ask about what the assistant said.
- **Then ask the question as a new Run** at `question_date` (recall + the Background Model or chat Model answers), and record the `hypothesis`.
- **Score with LongMemEval's own judge prompts, copied verbatim** (below), at temperature 0, label = `"yes"` appears in the lowercased reply. Report per-type accuracy plus overall. The paper's judge is `gpt-4o-2024-08-06`; any other judge makes our numbers incomparable with published ones, which is fine for a regression signal.
- **Don't vendor the data.** Commit the list of 40 `question_id`s and a script that downloads the S file from the pinned Hugging Face revision into a gitignored cache. MIT allows vendoring (with the notice), but the file is 277 MB and the filler sessions are third-party chat logs.

---

## The dataset

### Variants and size

| File (cleaned release)       | Size    | History per question                                                                                                           |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `longmemeval_oracle.json`    | 15.4 MB | only the evidence sessions (mean 2 per question, _measured_)                                                                   |
| `longmemeval_s_cleaned.json` | 277 MB  | about 115k tokens, about 40–50 sessions (README; paper: "about 50"); mean 48 sessions, 494 turns, 489k characters (_measured_) |
| `longmemeval_m_cleaned.json` | 2.74 GB | about 500 sessions, about 1.5M tokens (paper)                                                                                  |

Sizes from the Hugging Face tree API. Each file holds the same **500 questions** (README). The cleaned release (2025-09) "removes noisy history sessions that interfere with the answer correctness" and replaces the original (dataset card; README News). LongMemEval-V2 (2026-05, "long-term memory in agentic context") is a separate benchmark and out of scope.

### Fields

Per instance (README "Dataset Format", confirmed in both files):

- `question_id`; ends in `_abs` for an abstention question.
- `question_type`: `single-session-user`, `single-session-assistant`, `single-session-preference`, `temporal-reasoning`, `knowledge-update`, `multi-session`.
- `question`, `answer` (string, sometimes a number, _measured_), `question_date`.
- `haystack_session_ids`, `haystack_dates`, `haystack_sessions`: parallel lists. A session is a list of turns `{ role: "user" | "assistant", content, has_answer?: true }`. Sorted by timestamp in S and M; **not sorted in oracle**.
- `answer_session_ids`: the evidence sessions. In the data their ids start with `answer_` (_measured_: 948/948 in S).

Dates are strings like `"2023/05/20 (Sat) 02:21"`. In S they span 2021-05 to 2024-02 (_measured_); the paper says evidence sessions carry preset timestamps and nearby fillers get timestamps around them.

Two traps found while measuring:

- **`question_date` differs between oracle and S for every question** (500/500), though the evidence session ids match. Always take the question date and the history from the same file.
- `has_answer` marks 854 of the 948 evidence sessions in S (_measured_), so don't rely on it to find evidence; use `answer_session_ids`.

Evidence sessions were generated by Llama 3 70B self-chat (the simulated user states each fact indirectly), about 70% then human-edited; fillers are 25% ShareGPT, 25% UltraChat, 50% simulated sessions (paper, benchmark construction).

### Question types

Five abilities across six `question_type`s plus abstention (README; counts _measured_):

| Ability                 | `question_type`             | Count (+ `_abs`) | Example (question → answer)                                                                                    |
| ----------------------- | --------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| Information extraction  | `single-session-user`       | 64 (+6)          | "What degree did I graduate with?" → Business Administration                                                   |
|                         | `single-session-assistant`  | 56               | "...remind me what was the rotation for Admon on a Sunday?" → 8 am – 4 pm                                      |
|                         | `single-session-preference` | 30               | "Can you recommend some resources... video editing?" → a rubric: prefers Adobe Premiere Pro, advanced settings |
| Multi-session reasoning | `multi-session`             | 121 (+12)        | "How many items of clothing do I need to pick up or return?" → 3                                               |
| Knowledge updates       | `knowledge-update`          | 72 (+6)          | "What was my personal best time in the charity 5K run?" → 25:50                                                |
| Temporal reasoning      | `temporal-reasoning`        | 127 (+6)         | "How many days passed between my visit to MoMA and the 'Ancient Civilizations' exhibit?" → 7 (8 also accepted) |
| Abstention              | any, id ends `_abs`         | 30 in total      | "What is the name of my hamster?" → "You did not mention this... cat Luna but not your hamster."               |

The preference answers are rubrics, not answers; the abstention answers are explanations. The judge prompts handle both.

### Licence

- Repo: MIT (GitHub licence API, `LICENSE`). Dataset card: `license: mit`. The paper says the benchmark is released under MIT and that its ShareGPT fillers are Apache 2.0 and UltraChat MIT.
- So vendoring a subset is permitted with the MIT notice. We still shouldn't: the S file is 277 MB, a 40-case trimmed subset is still about 4 MB of mostly third-party chat text, and downloading a pinned revision is reproducible.

---

## Scoring: the judge prompts

From `src/evaluation/evaluate_qa.py` (`get_anscheck_prompt`), verbatim. Each is one user message; the call is `temperature: 0`, `max_tokens: 10`, and the label is `'yes' in reply.lower()`. Abstention is chosen by `'_abs' in question_id`, before the type.

**`single-session-user`, `single-session-assistant`, `multi-session`:**

```text
I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.

Question: {}

Correct Answer: {}

Model Response: {}

Is the model response correct? Answer yes or no only.
```

**`temporal-reasoning`:** the same, with this inserted after "answer no.":

```text
In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.
```

**`knowledge-update`:**

```text
I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.

Question: {}

Correct Answer: {}

Model Response: {}

Is the model response correct? Answer yes or no only.
```

**`single-session-preference`:**

```text
I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.

Question: {}

Rubric: {}

Model Response: {}

Is the model response correct? Answer yes or no only.
```

**Abstention (`_abs`):**

```text
I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.

Question: {}

Explanation: {}

Model Response: {}

Does the model correctly identify the question as unanswerable? Answer yes or no only.
```

Metrics (`print_qa_metrics.py`): per-type accuracy, **task-averaged accuracy** (mean of the six per-type means; `_abs` questions count under their type), overall accuracy, and abstention accuracy separately. The paper reports the GPT-4o judge agrees with human experts more than 97% of the time (meta-evaluation in Appendix A.4). The script only accepts `gpt-4o`, `gpt-4o-mini` or a local Llama 3.1 70B as judge, so we reimplement it in TypeScript rather than run it.

For calibration: with the whole history in context, GPT-4o scores 0.870 on oracle and 0.606 on S; Llama 3.1 8B 0.710 → 0.454 (paper, long-context results without Chain-of-Note).

---

## Picking 30–50 cases

**Quota (40 cases)**, roughly in proportion to the dataset but with the small types kept visible:

| Type                          | Cases |
| ----------------------------- | ----- |
| `single-session-user`         | 6     |
| `single-session-assistant`    | 4     |
| `single-session-preference`   | 4     |
| `multi-session`               | 8     |
| `temporal-reasoning`          | 8     |
| `knowledge-update`            | 6     |
| abstention (`_abs`, any type) | 4     |

`knowledge-update` and `temporal-reasoning` are where Memory's design is tested hardest (marking Memories invalid, and timestamps on Memories), so they get the most weight after `multi-session`. A reproducible starting set is the first _n_ `question_id`s per type in sorted order; the owner can hand-swap cases that look ambiguous. The first-_n_ set measured here: `001be529 0862e8bf 118b2229 15745da0 19b5f2b3 1e043500` (SSU), `0e5e2d1a 1568498a 16c90bf4 18dcd5a5` (SSA), `06878be2 06f04340 07b6f563 09d032c9` (SSP), `00ca467f 0100672e 078150f1 099778bb 09ba9854 0a995998 0ea62687 10d9b85a` (MS), `08f4fc43 0bb5a684 0bc8ad92 0bc8ad93 0db4c65d 2a1811e2 2c63a862 2ebe6c90` (TR), `01493427 031748ae 06db6396 07741c44 07741c45 08e075c7` (KU), `031748ae_abs 0862e8bf_abs 09ba9854_abs 0ddfec37_abs` (abstention).

**History per case.** Evidence sessions + first 8 fillers from the S haystack, kept in timestamp order: mean 10 sessions, 105 turns, 108k characters per case (_measured_ over all 500).

### Cost per run

Assume about 4.25 characters per token (S's 489k characters ≈ the README's 115k tokens). An extraction call sees one user/assistant pair plus its prompt and the similar existing Memories; budget about 1.5k tokens of overhead per call. The answer and judge calls are negligible (40 + 40 short calls).

| History                                | Extraction calls (40 cases) | Input tokens (40 cases)               |
| -------------------------------------- | --------------------------- | ------------------------------------- |
| Oracle (evidence only)                 | ~450                        | ~0.9M (230k of history + overhead)    |
| **Evidence + 8 fillers (recommended)** | **~2,000**                  | **~4M** (1M of history + 3M overhead) |
| Full S                                 | ~10,000                     | ~19M                                  |

Measured for the 40-case set above: 4,016 turns (≈2,000 pairs) and 4.16M characters with 8 fillers; 0.96M characters of evidence alone. Multiply the input-token column by the Background Model's input price; at an illustrative $0.15 per million input tokens the recommended run is about $0.60, full S about $3. Output tokens (extracted facts, add/update/delete decisions) are small but priced higher, so check them on the first real run. Wall-clock matters more than money: 2,000 sequential calls is tens of minutes, so run cases in parallel.

---

## LoCoMo, for comparison

From the LoCoMo README, `LICENSE.txt` and `data/locomo10.json` (_measured_):

- 10 conversations (the released subset of 50), 272 sessions, 5,882 turns, about 73k characters per conversation; 1,986 QA pairs in categories 1–5 (282 / 321 / 96 / 841 / 446).
- Each conversation is between **two simulated people** (`speaker_a`, `speaker_b`), with session timestamps like `"1:56 pm on 8 May, 2023"`, image captions, and generated observations and summaries.
- Scored by **token F1** (exact match for some), not an LLM judge; category 5 (adversarial) passes only if the output contains "no information available" or "not mentioned" (`task_eval/evaluation.py`).
- Licence: **CC BY-NC 4.0** (non-commercial).

It fits worse: there is no "user" whose facts an assistant should remember, F1 punishes correct paraphrases, and the NC licence is a problem for a product repo. Use LongMemEval.
