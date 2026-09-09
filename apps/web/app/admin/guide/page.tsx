import { Guide } from "@/components/guide";
import { readGuide } from "@/lib/guides";

export const dynamic = "force-static";
export const metadata = { title: "Guide" };

export default function AdminGuidePage() {
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Guide</h1>
          <p>Running the platform: workspaces, operations, backups and what to do when something breaks.</p>
        </div>
      </div>
      <Guide markdown={readGuide("admin-guide")} />
    </>
  );
}
