import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { useI18n } from "@botsdk/react/provider";
import type {
  Expectation,
  RepresentativeView,
  TestConversation,
  TestResultStatus,
  TranscriptEntry,
} from "@botsdk/representative/client";

/*
 * A draft's test conversations (ticket #1192): the editor, with the expectations code checks, and
 * the results with each transcript. A failed or errored conversation is shown open.
 */

const kindKeys = {
  replied: "representative.expectReplied",
  handed_off: "representative.expectHandedOff",
  not_handed_off: "representative.expectNotHandedOff",
  said: "representative.expectSaid",
  not_said: "representative.expectNotSaid",
} as const satisfies Record<Expectation["kind"], string>;

const kinds = Object.keys(kindKeys) as Expectation["kind"][];

const withText = (kind: Expectation["kind"]) => kind === "said" || kind === "not_said";

const blankTest = (): TestConversation => ({
  name: "",
  message: "",
  expect: [{ kind: "replied" }],
});

/** The draft's test conversations, edited in place and saved with the draft. */
export function TestConversationsEditor({
  tests,
  onChange,
}: {
  tests: TestConversation[];
  onChange: (tests: TestConversation[]) => void;
}) {
  const { t } = useI18n();
  const change = (index: number, test: TestConversation) =>
    onChange(tests.map((each, at) => (at === index ? test : each)));
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{t("representative.tests")}</h2>
        <p className="text-xs text-muted-foreground">{t("representative.testsHelp")}</p>
      </div>
      {tests.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("representative.noTests")}</p>
      )}
      {tests.map((test, index) => (
        <fieldset key={index} className="space-y-2 rounded-xl border p-3">
          <div className="space-y-1">
            <Label htmlFor={`representative-test-name-${index}`}>
              {t("representative.testName")}
            </Label>
            <Input
              id={`representative-test-name-${index}`}
              value={test.name}
              maxLength={100}
              onChange={(event) => change(index, { ...test, name: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`representative-test-message-${index}`}>
              {t("representative.testMessage")}
            </Label>
            <Textarea
              id={`representative-test-message-${index}`}
              rows={2}
              value={test.message}
              onChange={(event) => change(index, { ...test, message: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium">{t("representative.expectations")}</p>
            {test.expect.map((expectation, at) => (
              <div key={at} className="flex flex-wrap items-center gap-2">
                <select
                  aria-label={t("representative.expectation")}
                  value={expectation.kind}
                  onChange={(event) => {
                    const kind = event.target.value as Expectation["kind"];
                    const next: Expectation = withText(kind)
                      ? ({
                          kind,
                          text: "text" in expectation ? expectation.text : "",
                        } as Expectation)
                      : ({ kind } as Expectation);
                    change(index, {
                      ...test,
                      expect: test.expect.map((each, i) => (i === at ? next : each)),
                    });
                  }}
                  className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm"
                >
                  {kinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(kindKeys[kind])}
                    </option>
                  ))}
                </select>
                {"text" in expectation && (
                  <Input
                    aria-label={t("representative.expectationText")}
                    className="w-56"
                    value={expectation.text}
                    maxLength={500}
                    onChange={(event) =>
                      change(index, {
                        ...test,
                        expect: test.expect.map((each, i) =>
                          i === at ? ({ ...each, text: event.target.value } as Expectation) : each,
                        ),
                      })
                    }
                  />
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={test.expect.length === 1}
                  onClick={() =>
                    change(index, { ...test, expect: test.expect.filter((_, i) => i !== at) })
                  }
                >
                  {t("representative.removeExpectation")}
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() =>
                change(index, { ...test, expect: [...test.expect, { kind: "replied" }] })
              }
            >
              {t("representative.addExpectation")}
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() => onChange(tests.filter((_, at) => at !== index))}
          >
            {t("representative.removeTest")}
          </Button>
        </fieldset>
      ))}
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => onChange([...tests, blankTest()])}
      >
        {t("representative.addTest")}
      </Button>
    </section>
  );
}

const statusKeys = {
  queued: "representative.testQueued",
  running: "representative.testRunning",
  passed: "representative.testPassed",
  failed: "representative.testFailed",
  error: "representative.testError",
} as const satisfies Record<TestResultStatus, string>;

const roleKeys = {
  customer: "representative.roleCustomer",
  representative: "representative.roleRepresentative",
  tool: "representative.roleTool",
  system: "representative.roleSystem",
} as const satisfies Record<TranscriptEntry["role"], string>;

const stateKeys = {
  notRun: "representative.testsNotRun",
  running: "representative.testsRunning",
  failed: "representative.testsFailed",
  passed: "representative.testsPassed",
} as const;

/** The results that count for the draft as it is now: each conversation's transcript and checks. */
export function TestResults({ representative }: { representative: RepresentativeView }) {
  const { t } = useI18n();
  if (representative.testStatus === "none") return null;
  return (
    <section className="space-y-2" aria-label={t("representative.testResults")}>
      <h2 className="text-sm font-medium">{t("representative.testResults")}</h2>
      <p className="text-xs text-muted-foreground" data-test-status={representative.testStatus}>
        {t(stateKeys[representative.testStatus])}
      </p>
      {representative.tests.map((test) => (
        <details
          key={test.position}
          data-test-result={test.status}
          // Failures are open, so they are the first thing read.
          open={test.status === "failed" || test.status === "error"}
          className="rounded-xl border px-3 py-2 text-sm"
        >
          <summary className="cursor-pointer font-medium">
            {test.name} <span className="font-normal">({t(statusKeys[test.status])})</span>
          </summary>
          <div className="mt-2 space-y-2">
            {test.error !== null && <p className="text-destructive">{test.error}</p>}
            <ul className="space-y-1">
              {test.checks.map((check, at) => (
                <li key={at}>
                  {check.passed ? t("representative.checkPassed") : t("representative.checkFailed")}
                  {": "}
                  {check.detail}
                </li>
              ))}
            </ul>
            <ol className="space-y-1 text-xs">
              {test.transcript.map((entry, at) => (
                <li key={at}>
                  <span className="font-medium">{t(roleKeys[entry.role])}:</span>{" "}
                  <span className="whitespace-pre-wrap">{entry.text}</span>
                </li>
              ))}
            </ol>
          </div>
        </details>
      ))}
    </section>
  );
}
