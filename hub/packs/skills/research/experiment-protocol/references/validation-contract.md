# Validation contract

The harness reads the contract from `.pancode/validation.yaml` at the repository
root (`.pancode/validation.yml`, `validation.yaml` and `validation.yml` are
also accepted). Only a YAML contract that parses raises rigor; `VALIDATION.md`
is advisory prose. Unknown fields fail the parse, and a contract that fails
to parse raises nothing.

## Fields

The schema accepts `version` (always `1`), `task`, `runtime` (`kind` of
`local`, `slurm`, `mpi` or `other`, plus optional `nodes`, `ranks`, `walltime`,
`modules`), `artifacts` (each a `path` with optional `format`,
`expected_dimensions`, `expected_attributes`, `numerical_tolerances` of
`relative`, `absolute` or `ulp`, and `preserve`), `validators` (command prose,
never executed) and free-text `notes`. Put what has no field of its own, such
as thresholds, verdict conditions and the dead-ends ledger, in `notes`.

Size caps: 256 KiB per file, 4 KiB per text field, 16 KiB of `notes`,
256 artifacts, 128 validators, 64 modules.

## Example

The halo-exchange study from the skill's worked example:

```yaml
# .pancode/validation.yaml
version: 1
task: "halo-exchange-overlap: overlap communication with interior compute for at least 1.5x step throughput at equal accuracy"
runtime:
  kind: mpi
  nodes: 4
  modules: [gcc/13.2, openmpi/4.1.6]
artifacts:
  - path: results/solution-l2.txt
    numerical_tolerances: { absolute: 1.0e-12 }
    preserve: true
validators:
  - "srun -N 4 --exclusive --cpu-bind=cores ./halo_bench data/mesh-256.h5"
notes: |
  Thresholds (step throughput vs baseline): minimum 1.2x, target 1.5x, stretch 2.0x.
  step_time: relative, 5% run-to-run variance. solution_l2: absolute, 1e-12 vs baseline.
  Environment: gcc 13.2 -O3, openmpi 4.1.6, cpu-bind=cores, exclusive nodes.
  Input: data/mesh-256.h5, sha256 <checksum>.
  Confirmed: speedup >= 1.2x and solution_l2 within tolerance.
  Refuted: speedup < 1.2x with variance under 5%, or any accuracy loss.
  Inconclusive: variance over 5%; resize repetitions first.
  Dead ends: none yet.
```
