import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  type CustomRule,
  type CustomRuleMode,
  customRuleModes,
  maxActiveCustomRules,
  maxCustomRuleLength,
} from "@botsdk/client/bot/rule";
import { useRef, useState } from "react";

import { newRuleKey, useCustomRules, useNeverAllowed } from "@botsdk/react/bot/rules";
import { useI18n } from "@botsdk/react/provider";
import { useRefusalToast } from "../bot/refusal-toast";
import { modeKeys, RuleCard } from "../bot/rule-card";

type Rules = ReturnType<typeof useCustomRules>;

/** The four modes as pills: one is chosen. */
function ModePills({
  value,
  onChange,
  disabled,
}: {
  value: CustomRuleMode;
  onChange: (mode: CustomRuleMode) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <div role="radiogroup" aria-label={t("settings.ruleMode")} className="flex flex-wrap gap-1.5">
      {customRuleModes.map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={mode === value}
          disabled={disabled}
          onClick={() => mode !== value && onChange(mode)}
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50",
            mode === value
              ? "border-primary bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          {t(modeKeys[mode])}
        </button>
      ))}
    </div>
  );
}

/**
 * One of the user's rules: its text saves when the field loses focus, its mode when a pill is
 * chosen. A change made while another saves (a pill clicked as the field's blur saves its text)
 * waits its turn, so both land.
 */
function RuleRow({
  rule,
  busy,
  update,
  remove,
}: {
  rule: CustomRule;
  busy: boolean;
  update: Rules["update"];
  remove: Rules["remove"];
}) {
  const { t } = useI18n();
  const run = useRefusalToast();
  const [text, setText] = useState(rule.text);
  const [mode, setMode] = useState(rule.mode);
  const queued = useRef<{ text?: string; mode?: CustomRuleMode }>({});
  const saving = useRef(false);
  const save = async (change: { text?: string; mode?: CustomRuleMode }) => {
    Object.assign(queued.current, change);
    if (saving.current) return;
    saving.current = true;
    try {
      while (Object.keys(queued.current).length > 0) {
        const next = queued.current;
        queued.current = {};
        await update(rule.id, next);
      }
    } finally {
      saving.current = false;
    }
  };
  return (
    <li data-rule={rule.id} className="space-y-2 px-4 py-3">
      <Textarea
        aria-label={t("settings.ruleText")}
        value={text}
        maxLength={maxCustomRuleLength}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const trimmed = text.trim();
          // A blank field would be refused: it goes back to the saved text.
          if (trimmed === "") setText(rule.text);
          else if (trimmed !== rule.text) run(save({ text: trimmed }));
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <ModePills
          value={mode}
          disabled={false}
          onChange={(chosen) => {
            setMode(chosen);
            run(save({ mode: chosen }));
          }}
        />
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={busy}
          onClick={() => run(remove(rule.id))}
        >
          {t("settings.deleteRule")}
        </Button>
      </div>
    </li>
  );
}

/** The row for a rule being written: it saves with the Save button. */
function NewRuleRow({
  busy,
  create,
  onDone,
}: {
  busy: boolean;
  create: Rules["create"];
  onDone: () => void;
}) {
  const { t } = useI18n();
  const run = useRefusalToast();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<CustomRuleMode>("pre_approved");
  return (
    <li data-rule={newRuleKey} className="space-y-2 px-4 py-3">
      <Textarea
        aria-label={t("settings.ruleText")}
        placeholder={t("settings.ruleTextPlaceholder")}
        value={text}
        maxLength={maxCustomRuleLength}
        disabled={busy}
        autoFocus
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <ModePills value={mode} disabled={busy} onChange={setMode} />
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onDone}>
            {t("pages.cancel")}
          </Button>
          <Button
            size="sm"
            disabled={busy || text.trim() === ""}
            onClick={() => run(create({ text: text.trim(), mode }).then(onDone))}
          >
            {t("settings.saveRule")}
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * Rules (spec #989): the user's Custom Rules, shared by all their Bots, each a text field with four
 * mode pills, with "Add a rule", delete, the limit and a footnote on what rules reach. The Host
 * mounts it at `/settings/rules`.
 */
export function RulesPage() {
  const { t } = useI18n();
  const { rules, loading, acting, create, update, remove, approve, deny } = useCustomRules();
  const neverAllowed = useNeverAllowed();
  const [adding, setAdding] = useState(false);
  // A rule a Bot proposed isn't in force to edit: it waits for Approve or Deny, in its own list.
  const active = rules.filter((rule) => rule.state === "active");
  const proposed = rules.filter((rule) => rule.state === "proposed");
  const full = active.length >= maxActiveCustomRules;

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{t("settings.rulesTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.rulesIntro")}</p>
      </div>

      {proposed.length > 0 && (
        <section className="space-y-2" aria-labelledby="proposed-rules-title">
          <h2 id="proposed-rules-title" className="text-sm font-semibold">
            {t("settings.rulesProposedTitle")}
          </h2>
          <ul aria-labelledby="proposed-rules-title" className="flex flex-col gap-2">
            {proposed.map((rule) => (
              <li key={rule.id} className="flex flex-col">
                <RuleCard
                  rule={rule}
                  onApprove={approve}
                  onDeny={deny}
                  acting={acting.has(rule.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {t("settings.rulesCount", { count: active.length, max: maxActiveCustomRules })}
          </p>
          <Button size="sm" disabled={full || adding} onClick={() => setAdding(true)}>
            {t("settings.addRule")}
          </Button>
        </div>
        {full && (
          <p role="status" className="text-xs text-muted-foreground">
            {t("settings.rulesLimit", { max: maxActiveCustomRules })}
          </p>
        )}
        {!loading && active.length === 0 && !adding && (
          <p className="text-sm text-muted-foreground">{t("settings.rulesEmpty")}</p>
        )}
        {(active.length > 0 || adding) && (
          <ul
            aria-label={t("settings.rulesTitle")}
            className="divide-y overflow-hidden rounded-xl border"
          >
            {active.map((rule) => (
              <RuleRow
                key={`${rule.id}:${rule.updatedAt.getTime()}`}
                rule={rule}
                busy={acting.has(rule.id)}
                update={update}
                remove={remove}
              />
            ))}
            {adding && (
              <NewRuleRow
                busy={acting.has(newRuleKey)}
                create={create}
                onDone={() => setAdding(false)}
              />
            )}
          </ul>
        )}
      </section>

      {neverAllowed.length > 0 && (
        <section className="space-y-2" aria-labelledby="never-allowed-title">
          <h2 id="never-allowed-title" className="text-sm font-semibold">
            {t("settings.neverAllowedTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("settings.neverAllowedIntro")}</p>
          <ul aria-labelledby="never-allowed-title" className="list-disc space-y-1 pl-6 text-sm">
            {neverAllowed.map((never) => (
              <li key={never}>{never}</li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-xs text-muted-foreground">{t("settings.rulesFootnote")}</p>
    </main>
  );
}
