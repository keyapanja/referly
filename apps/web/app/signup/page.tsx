"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, setToken } from "@/lib/api";
import { useAction } from "@/lib/hooks";
import { Alert, CopyBox, Field } from "@/components/ui";
import { toMinor } from "@/lib/format";
import { AuthBrand } from "@/components/shell";

const STEPS = ["Account", "Business", "First offer", "Program", "Invite"] as const;
const OFFER_TYPES = ["coaching", "course", "workshop", "event", "membership", "consulting", "custom"];

/**
 * Guided onboarding (PRD s9.1 / journey A). Each step calls the API immediately so a merchant
 * who stops half-way still has a usable workspace. Defaults follow the recommended V1 setup.
 */
export default function SignupPage() {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [step, setStep] = useState(0);

  const [account, setAccount] = useState({ name: "", email: "", password: "" });
  const [biz, setBiz] = useState({ name: "", slug: "", currency: "USD", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", businessType: "coaching" });
  const [offer, setOffer] = useState({ name: "", type: "coaching", price: "", salesUrl: "" });
  const [program, setProgram] = useState({ name: "Partner Program", commissionPercent: "20", holdingDays: "30", attributionWindowDays: "30", approvalMode: "manual", refundPolicy: "full", termsText: "Affiliates earn commission on sales attributed to their unique link or code. Commissions are paid after the holding period. Self-referrals and misleading promotion are not allowed." });
  const [invite, setInvite] = useState({ email: "", name: "" });

  const [offerId, setOfferId] = useState<string | null>(null);
  const [programInfo, setProgramInfo] = useState<{ id: string; joinUrl: string } | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);

  async function submitStep(e: React.FormEvent) {
    e.preventDefault();
    if (step === 0) return setStep(1);
    if (step === 1) {
      const res = await run(() =>
        api<any>("/v1/auth/signup", {
          method: "POST",
          token: null,
          json: { name: biz.name, slug: biz.slug || slugify(biz.name), currency: biz.currency, timezone: biz.timezone, businessType: biz.businessType, owner: { name: account.name, email: account.email, password: account.password } },
        }),
      );
      if (!res) return;
      setToken(res.token);
      return setStep(2);
    }
    if (step === 2) {
      const res = await run(async () => {
        const created = await api<any>("/v1/offers", { method: "POST", json: { name: offer.name, type: offer.type, priceMinor: toMinor(offer.price), salesUrl: offer.salesUrl } });
        await api(`/v1/offers/${created.offer.id}/status`, { method: "POST", json: { status: "active" } });
        return created.offer.id as string;
      });
      if (!res) return;
      setOfferId(res);
      return setStep(3);
    }
    if (step === 3) {
      const res = await run(async () => {
        const created = await api<any>("/v1/programs", {
          method: "POST",
          json: {
            name: program.name,
            commissionModel: "percentage",
            commissionPercent: Number(program.commissionPercent),
            holdingDays: Number(program.holdingDays),
            attributionWindowDays: Number(program.attributionWindowDays),
            approvalMode: program.approvalMode,
            refundPolicy: program.refundPolicy,
            termsText: program.termsText,
            offerIds: offerId ? [offerId] : [],
          },
        });
        await api(`/v1/programs/${created.program.id}/status`, { method: "POST", json: { status: "active" } });
        const detail = await api<any>(`/v1/programs/${created.program.id}`);
        return { id: created.program.id as string, joinUrl: detail.joinUrl as string };
      });
      if (!res) return;
      setProgramInfo(res);
      return setStep(4);
    }
    if (step === 4) {
      if (!invite.email) return router.replace("/app");
      const res = await run(() => api<any>("/v1/affiliates/invites", { method: "POST", json: { programId: programInfo!.id, email: invite.email, name: invite.name || undefined } }));
      if (!res) return;
      setInviteUrl(res.acceptUrl);
    }
  }

  return (
    <div className="center wide">
      <div className="card">
        <AuthBrand subtitle="Self-serve setup" />
        <h1>Launch your affiliate program</h1>
        <p className="muted">About five minutes. You can change everything later.</p>
        <div className="steps">
          {STEPS.map((s, i) => (
            <span key={s} className={i < step ? "done" : i === step ? "current" : ""}>
              {i + 1}. {s}
            </span>
          ))}
        </div>
        <Alert kind="error">{error}</Alert>
        <form onSubmit={submitStep}>
          {step === 0 && (
            <>
              <Field label="Your name">
                <input value={account.name} onChange={(e) => setAccount({ ...account, name: e.target.value })} required />
              </Field>
              <Field label="Email">
                <input type="email" value={account.email} onChange={(e) => setAccount({ ...account, email: e.target.value })} required />
              </Field>
              <Field label="Password" help="At least 8 characters.">
                <input type="password" value={account.password} onChange={(e) => setAccount({ ...account, password: e.target.value })} minLength={8} required />
              </Field>
            </>
          )}
          {step === 1 && (
            <>
              <Field label="Business name">
                <input value={biz.name} onChange={(e) => setBiz({ ...biz, name: e.target.value, slug: biz.slug || slugify(e.target.value) })} required />
              </Field>
              <Field label="Workspace URL name" help="Lowercase letters, numbers and hyphens.">
                <input value={biz.slug} onChange={(e) => setBiz({ ...biz, slug: slugify(e.target.value) })} required minLength={3} />
              </Field>
              <div className="row">
                <Field label="Business type">
                  <select value={biz.businessType} onChange={(e) => setBiz({ ...biz, businessType: e.target.value })}>
                    {OFFER_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Currency (ISO code)">
                  <input value={biz.currency} onChange={(e) => setBiz({ ...biz, currency: e.target.value.toUpperCase() })} maxLength={3} minLength={3} required />
                </Field>
              </div>
              <Field label="Timezone">
                <input value={biz.timezone} onChange={(e) => setBiz({ ...biz, timezone: e.target.value })} required />
              </Field>
            </>
          )}
          {step === 2 && (
            <>
              <p className="muted">What are affiliates going to promote first?</p>
              <Field label="Offer name">
                <input value={offer.name} onChange={(e) => setOffer({ ...offer, name: e.target.value })} required />
              </Field>
              <div className="row">
                <Field label="Type">
                  <select value={offer.type} onChange={(e) => setOffer({ ...offer, type: e.target.value })}>
                    {OFFER_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`Price (${biz.currency})`}>
                  <input inputMode="decimal" value={offer.price} onChange={(e) => setOffer({ ...offer, price: e.target.value })} placeholder="499.00" required />
                </Field>
              </div>
              <Field label="Sales page URL" help="Where affiliate links send visitors. Your checkout will report sales back to us.">
                <input type="url" value={offer.salesUrl} onChange={(e) => setOffer({ ...offer, salesUrl: e.target.value })} placeholder="https://yourdomain.com/course" required />
              </Field>
            </>
          )}
          {step === 3 && (
            <>
              <Field label="Program name">
                <input value={program.name} onChange={(e) => setProgram({ ...program, name: e.target.value })} required />
              </Field>
              <div className="row">
                <Field label="Commission (% of sale)">
                  <input inputMode="decimal" value={program.commissionPercent} onChange={(e) => setProgram({ ...program, commissionPercent: e.target.value })} required />
                </Field>
                <Field label="Holding period (days)" help="Commissions become payable after this many days, covering refunds.">
                  <input inputMode="numeric" value={program.holdingDays} onChange={(e) => setProgram({ ...program, holdingDays: e.target.value })} required />
                </Field>
              </div>
              <div className="row">
                <Field label="Attribution window (days)" help="How long after a click a sale still counts.">
                  <input inputMode="numeric" value={program.attributionWindowDays} onChange={(e) => setProgram({ ...program, attributionWindowDays: e.target.value })} required />
                </Field>
                <Field label="Affiliate approval">
                  <select value={program.approvalMode} onChange={(e) => setProgram({ ...program, approvalMode: e.target.value })}>
                    <option value="manual">Review each application</option>
                    <option value="auto">Approve automatically</option>
                    <option value="invite_only">Invite only</option>
                  </select>
                </Field>
              </div>
              <Field label="On refund">
                <select value={program.refundPolicy} onChange={(e) => setProgram({ ...program, refundPolicy: e.target.value })}>
                  <option value="full">Reverse the whole commission</option>
                  <option value="partial">Reduce commission proportionally</option>
                  <option value="none">Keep the commission</option>
                </select>
              </Field>
              <Field label="Program terms" help="Affiliates must accept these before promoting.">
                <textarea value={program.termsText} onChange={(e) => setProgram({ ...program, termsText: e.target.value })} />
              </Field>
            </>
          )}
          {step === 4 && (
            <>
              <Alert kind="success">Your program is live. Share your application page or invite someone directly.</Alert>
              <Field label="Application page">
                <CopyBox value={programInfo?.joinUrl ?? ""} />
              </Field>
              {inviteUrl ? (
                <Alert kind="info">
                  Invitation sent to {invite.email}. Accept link: <CopyBox value={inviteUrl} />
                </Alert>
              ) : (
                <div className="row">
                  <Field label="Invite an affiliate by email (optional)">
                    <input type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
                  </Field>
                  <Field label="Their name">
                    <input value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
                  </Field>
                </div>
              )}
            </>
          )}
          <div className="actions" style={{ marginTop: 4 }}>
            {step > 0 && step < 2 ? (
              <button type="button" onClick={() => setStep(step - 1)}>
                Back
              </button>
            ) : null}
            {step < 4 ? (
              <button className="primary" type="submit" disabled={busy}>
                {busy ? "Saving…" : step === 3 ? "Create program" : "Continue"}
              </button>
            ) : inviteUrl ? (
              <Link className="btn primary" href="/app">
                Go to dashboard
              </Link>
            ) : (
              <>
                <button className="primary" type="submit" disabled={busy || !invite.email}>
                  Send invite
                </button>
                <Link className="btn" href="/app">
                  Skip for now
                </Link>
              </>
            )}
          </div>
        </form>
        {step === 0 ? (
          <p className="footnote">
            Already have a workspace? <Link href="/login">Sign in</Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}
