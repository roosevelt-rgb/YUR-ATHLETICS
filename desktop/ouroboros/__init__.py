"""
Ouroboros — a fail-closed, 80/20 governed autonomous production loop for the Abel repo.

The serpent that consumes and produces itself. A spec is ingested, grounded,
gated deterministically (the 80%), handed to a producer inside a governance cage
(the 20%), re-validated, and either promoted as a real artifact or quarantined
and rolled back. State lives on disk (crash-proof); the frozen kernel is never
touched; secrets are never read.

Give never take. Fail closed. The frame stays.
"""

__version__ = "0.1.0"
