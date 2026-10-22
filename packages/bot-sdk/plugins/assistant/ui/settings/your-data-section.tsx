import { ExportDataButton } from "../../../../ui/settings/export-data-button";
import { useI18n } from "../../../../core/client/react/provider";

/** Settings: the Export your data download. */
export function YourDataSection() {
  const { t } = useI18n();
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{t("pages.yourData")}</h2>
      <p className="text-xs text-muted-foreground">{t("pages.yourDataHelp")}</p>
      <ExportDataButton />
    </section>
  );
}
