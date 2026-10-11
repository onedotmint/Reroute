/** Compile-only checks against the installed vendor declarations; never instantiate/authenticate Daytona. */
import type * as ActualSdk from '../../.tools/node_modules/@daytona/sdk/esm/index.js';
import type {
  DaytonaSdk, DaytonaClient, DaytonaSandbox, DaytonaSandboxState, DaytonaGpuType,
  DaytonaCreateBaseParams, DaytonaCreateImageParams, DaytonaCreateSnapshotParams,
} from '../../src/providers/daytona.js';

declare const sdk: typeof ActualSdk;
declare const actualClient: ActualSdk.Daytona;
declare const actualSandbox: ActualSdk.Sandbox;
declare const sandbox: DaytonaSandbox;
declare const base: DaytonaCreateBaseParams;
declare const image: DaytonaCreateImageParams;
declare const snapshot: DaytonaCreateSnapshotParams;

const sdkBoundary: DaytonaSdk = sdk;
const clientBoundary: DaytonaClient = actualClient;
const sandboxBoundary: DaytonaSandbox = actualSandbox;
const vendorBase: ActualSdk.CreateSandboxBaseParams = base;
const vendorImage: ActualSdk.CreateSandboxFromImageParams = image;
const vendorSnapshot: ActualSdk.CreateSandboxFromSnapshotParams = snapshot;
const vendorState: ActualSdk.SandboxState | undefined = sandbox.state;
const boundaryState: DaytonaSandboxState | undefined = actualSandbox.state;
const vendorGpu: ActualSdk.GpuType = null as unknown as DaytonaGpuType;
// @ts-expect-error A100 is not a supported Daytona GPU type in the pinned SDK.
const unsupportedGpu: DaytonaGpuType = 'A100';

async function callShapes() {
  await actualClient.create(vendorSnapshot, { timeout: 60 });
  await actualClient.create(vendorImage, { timeout: 60 });
  await clientBoundary.create(snapshot, { timeout: 60 });
  await clientBoundary.create(image, { timeout: 60 });
  await actualClient.get('reroute-project');
  await actualClient.delete(actualSandbox, 60);
  await actualSandbox.start(60);
  await actualSandbox.stop(60);
  await actualSandbox.setAutostopInterval(10);
  await actualSandbox.refreshActivity();
  await actualSandbox.setAutoDeleteInterval(-1);
  await sandbox.refreshActivity();
  await sandbox.setAutoDeleteInterval(-1);
  const labels: Record<string, string> = actualSandbox.labels;
  const sandboxClass: DaytonaSandbox['sandboxClass'] = actualSandbox.sandboxClass;
  const gpu: number = actualSandbox.gpu;
  const spot: boolean | undefined = actualSandbox.spot;
  const autoDelete: number | undefined = actualSandbox.autoDeleteInterval;
  const deadline: string | undefined = actualSandbox.autoDestroyAt;
  const lifecycleBase: ActualSdk.CreateSandboxBaseParams = { autoDeleteInterval: -1, ttlMinutes: 0, ephemeral: false, spot: false };
  void [labels, sandboxClass, gpu, spot, autoDelete, deadline, lifecycleBase];
  const preview: { url: string; token: string } = await actualSandbox.getPreviewLink(3000);
  const signedPreview: { url: string; token: string } = await actualSandbox.getSignedPreviewUrl(3000, 300);
  const boundaryPreview: { url: string; token: string } = await sandbox.getSignedPreviewUrl(3000, 300);
  void signedPreview; void boundaryPreview;
  const ssh: { token: string; sshCommand: string; expiresAt: Date } = await actualSandbox.createSshAccess(30);
  return { sdkBoundary, sandboxBoundary, vendorBase, vendorState, boundaryState, vendorGpu, unsupportedGpu, preview, ssh };
}
void callShapes; // This file is only typechecked, not executed.
