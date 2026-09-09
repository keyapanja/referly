import { Guide } from "@/components/guide";
import { readGuide } from "@/lib/guides";

export const dynamic = "force-static";
export const metadata = { title: "Guide" };

export default function AffiliateGuidePage() {
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Guide</h1>
          <p>How to promote, track what you earn and get paid.</p>
        </div>
      </div>
      <Guide markdown={readGuide("affiliate-guide")} />
    </>
  );
}
