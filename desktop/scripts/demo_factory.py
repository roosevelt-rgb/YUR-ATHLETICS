"""Create a reviewable evidence-analysis specialist using synthetic input only."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from foundry.commit_service import CommitService
from foundry.orchestration import OrchestrationManager, local_authority
from foundry.sources import SourceRegistry


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True, type=Path)
    args = parser.parse_args()
    with CommitService(args.home) as store:
        manager = OrchestrationManager(store)
        mission = manager.submit({
            "name": "TERRA Evidence Analyst",
            "description": "Profile operator-provided tabular evidence and extract text signals. No valuation, external acquisition or investment decisions.",
            "capabilities": ["data.profile", "text.analyze"],
        }, "terra-evidence-analyst-acceptance-v1", local_authority())
        if mission["status"] == "queued":
            sources = SourceRegistry.from_environment().describe("terra", 3)
            store.record_event(mission["id"], "source.considered", {
                "sources": [source for source in sources["sources"] if source["id"] == "terra-pack"],
                "decision": "Compose admitted evidence-analysis capabilities; do not promote the donor's unbound market-intelligence claims"})
            manager.process(1)
        result = manager.run(mission["id"], "data.profile", {"rows": [
            {"record_id": "example-001", "source_reference": "synthetic-fixture", "observations": 12},
            {"record_id": "example-002", "source_reference": None, "observations": 7},
            {"record_id": "example-002", "source_reference": None, "observations": 7},
        ]})
        exported = store.export_artifact(mission["id"])
        print(json.dumps({"mission_id": mission["id"], "status": manager.inspect(mission["id"])["status"],
                          "input_kind": "synthetic acceptance fixture", "output": result["output"],
                          "execution_receipt_hash": result["receipt"]["hash"],
                          "export": exported, "integrity": store.verify_integrity()}, indent=2))


if __name__ == "__main__":
    main()
