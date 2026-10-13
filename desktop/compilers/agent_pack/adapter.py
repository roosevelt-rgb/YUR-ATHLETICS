"""Bind the existing agent_pack.compiler manifest to the audited pack compiler."""
from foundry.pack_compiler import compile_pack, validate_pack


class AgentPackCompiler:
    def compile(self, payload, *, trace_id):
        if not isinstance(payload, dict):
            raise ValueError("compiler payload must be an object")
        result = compile_pack(payload.get("spec", payload), payload.get("strategy", "balanced"))
        validation = validate_pack(result.files)
        return {"engine": "foundry_agent_pack", "status": "validated_candidate" if validation["passed"] else "validation_failed",
                "trace_id": str(trace_id), "files": result.files, "cost": result.cost,
                "producer": result.producer, "validation": validation}
