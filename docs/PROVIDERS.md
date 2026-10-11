# Providers

All five provider classes are implemented and exercised through the same local
contract suite. Native SDK/CLI calls in that suite are fixtures; real Python
processes, filesystem mutations, cancellation and framed I/O are used beneath
them. **No provider is labelled live verified in this delivery.**

| Provider | Local prerequisites | Resource mapping | Persistence / idle | Preview |
| --- | --- | --- | --- | --- |
| Daytona | optional TS SDK, OpenSSH, native API key | CPU, MiB->GiB RAM, disk, GPU, target/region, image; snapshot constraints; GPU spot only | sandbox disk; native autostop disabled while active, stop after idle | native HTTPS preview |
| SSH | OpenSSH config/agent, known host key | no resource provisioning; explicit sizing requests rejected | isolated directory; never shuts down host | localhost SSH forwarding |
| SkyPilot | `sky`, OpenSSH, native cloud auth | SkyPilot resources/infra/instance/disk/image/accelerators/spot | cluster disk on stop; spot autodown can lose disk | SkyPilot-generated SSH config and forwarding |
| Modal | optional JS SDK, native token/profile | CPU/memory reservation and limits, GPU, regions, image | named volume; terminate/recreate, not VM suspend/resume | predeclared encrypted ports/tunnels |
| E2B | optional JS SDK, E2B API key | template-owned; portable CPU/memory/disk/image/region/spot rejected | pause/resume by default; `autoPause=false` kills instead | native port-host mapping |

Every remote must have Python 3 and the chosen project's toolchain. Reroute does
not promise nested Docker support. Region/GPU/spot availability still depends on
provider quotas, account limits and region inventory; requests can be rejected by
those services even when the field mapping exists.

## Daytona

Run `reroute setup --install-sdk daytona` after supplying `DAYTONA_API_KEY` through your
native environment. `DAYTONA_API_URL` is supported by the native SDK; custom
installations also require `providers.daytona.sshHost` for temporary SSH access.
Use `providers.daytona.target` or portable `runtime.region`, not a fabricated
universal region name. Snapshot resources are fixed: the adapter rejects portable
image/resource overrides combined with a snapshot.

`ensureReady` discovers by stable name before creation, then initializes an owned
workspace. Sessions use short-lived SSH access, refreshed in local memory. CPU
work and source transfer use one shared supervised SSH channel abstraction, not
a second independent Daytona sync system. `autoArchiveMinutes` and
`autoDeleteMinutes` are opt-in native lifecycle settings, not Reroute defaults.
Native volumes use `volumeId`, absolute `mountPath`, optional `subpath`.

The release does not expose every Daytona snapshot/secret/pause feature. Native
provider features not mapped here are not claimed as implemented.

## SSH

```sh
ssh my-build-host 'python3 --version'
reroute enable --provider ssh --host my-build-host
reroute doctor --probe
```

Optional `user`, `port`, `remoteRoot`, `bootstrap` live in `[providers.ssh]`.
Bootstrap is an explicit trusted remote command run for a new workspace, not an
implicit package-manager installation. Default workspaces are under
`~/.cache/reroute/workspaces/<uuid>` on the host. Destruction checks the directory
basename and owner marker before removing that directory. Existing SSH machines
are never powered off. Do not point a workspace at irreplaceable pre-existing data.

## SkyPilot

Authenticate/check clouds through `sky check`, then `reroute enable --provider skypilot`.
Use `[providers.skypilot]` for `infra`, `instanceType`, `diskTier`, `remoteRoot`,
`bootstrap`. Reroute writes a private JSON-as-YAML task and delegates provisioning
to `sky launch`; it does not duplicate cloud scheduling. Standard streams run over
SkyPilot's generated SSH alias instead of `sky exec` job-log polling.
`sky status`, `autostop`, `stop` and `down` retain native meanings. For spot clusters
idle cleanup uses autodown, which can remove mutable dependencies/build caches.

## Modal

`reroute setup --install-sdk modal` installs the inspected SDK release 0.11.0 into the
optional SDK directory. Use your native Modal profile or `MODAL_TOKEN_ID` and
`MODAL_TOKEN_SECRET`; none is copied into project config.

Default app is `reroute`, mount `/workspace`, named volume `reroute-<uuid>`.
A runtime has a finite native lifetime (`timeoutMs`, default 24h). Setting a shorter
native timeout can terminate even active dev work; Reroute cannot extend it as
if it were a VM lease. Resource regions map to the SDK's `regions` array.
`secrets` is an array of pre-existing native secret names, never secret values.
`ports` must be declared before creation. Named volumes are retained even by
`reroute stop --destroy`; remove them deliberately with native Modal tools after checking
data and storage charges. Volume persistence/commit behavior is live-unverified.

Cancelling one execution does not terminate the shared sandbox. If its stdin writer
stalls, fallback uses `ContainerProcess.closeStdin()` from the pinned SDK, independently
of the WritableStream queue. The worker handles that EOF by cleaning up its own process
group. This API was checked against the downloaded 0.11.0 declarations/implementation
and tested through an SDK boundary fixture with a real worker, not a live Modal account.

## E2B

`reroute setup --install-sdk e2b` installs the inspected SDK release 2.52.1.
Provide `E2B_API_KEY` natively. Default template is `base`; select/build your own
runtime template for actual project toolchains. Stable metadata allows reconnect
and detects duplicate runtime records instead of choosing one arbitrarily.
The native lifecycle uses `onTimeout: pause` (or kill when explicitly selected).
Active leases refresh a bounded timeout, default one hour; plan-level limits still
apply. `autoPause=false` destroys mutable state on idle. No invented generic CPU
allocation parameter is sent to the template API.

## Verification and operational boundary

`docs/REFERENCES.md` and `sdk-versions.json` record inspected upstream contracts.
SDKs were not installed in the delivery environment; structural declarations are
ours, not proof of vendor type compatibility. Run opt-in live tests before relying
on a provider, including preview, long-lived leases and native auth in your account.
No cloud registration, paid provisioning or account mutation was performed here.
