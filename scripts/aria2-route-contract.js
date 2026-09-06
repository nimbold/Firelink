export const ARIA2_FIRELINK_REVISION = 'firelink-native-dns-v1';
export const ARIA2_DNS_RESOLVER = 'native-async';
export const ARIA2_NETWORK_TARGET_POLICY = 'firelink-v1';
export const ARIA2_NETWORK_TARGET_POLICY_DIGEST =
  'sha256:064503d30f1a043e79113f7e44ddfb517fbf2c578a332896355180743eaf1705';

// The standard Aria2 option is the production default. It keeps hostname
// resolution on the OS/TUN route and is accepted by stock and patched builds.
// There is intentionally no daemon-wide flag here: async-dns=false is stamped
// per transfer after the caller has selected the compatible route.
export const ARIA2_SYSTEM_RESOLVER_DAEMON_ARGS = Object.freeze([]);
export const ARIA2_SYSTEM_RESOLVER_OPTIONS = Object.freeze({
  'async-dns': 'false',
});

// Firelink-patched Aria2 exposes these options for the bounded alternate
// magnet-probe attempt. They must never be sent to an unverified binary.
export const ARIA2_ROUTE_DAEMON_ARGS = Object.freeze([
  '--async-dns=true',
  `--dns-resolver=${ARIA2_DNS_RESOLVER}`,
  `--network-target-policy=${ARIA2_NETWORK_TARGET_POLICY}`,
]);

export const ARIA2_ROUTE_OPTIONS = Object.freeze({
  'async-dns': 'true',
  'dns-resolver': ARIA2_DNS_RESOLVER,
  'network-target-policy': ARIA2_NETWORK_TARGET_POLICY,
});

// Local HTTP servers are used only by engine smoke tests. Product transfers
// never apply the fixture exception; Firelink's own admission policy still
// rejects literal local targets before Aria2 is contacted.
export const ARIA2_LOCAL_FIXTURE_OPTIONS = Object.freeze({
  ...ARIA2_SYSTEM_RESOLVER_OPTIONS,
});

export function assertAria2Baseline(version) {
  if (typeof version?.version !== 'string' || version.version.trim() === '') {
    throw new Error(`aria2 returned an invalid baseline version response: ${JSON.stringify(version)}`);
  }
}

export function assertAria2RouteCapabilities(version) {
  if (!Array.isArray(version?.enabledFeatures)
      || !version.enabledFeatures.includes('Async DNS')) {
    throw new Error(`aria2 does not advertise asynchronous DNS: ${JSON.stringify(version)}`);
  }
  const expected = {
    firelinkRevision: ARIA2_FIRELINK_REVISION,
    firelinkNetworkTargetPolicyDigest: ARIA2_NETWORK_TARGET_POLICY_DIGEST,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (version?.[field] !== value) {
      throw new Error(`aria2 route capability mismatch for ${field}: ${JSON.stringify(version)}`);
    }
  }
  if (!Array.isArray(version.firelinkDnsResolvers)
      || !version.firelinkDnsResolvers.includes(ARIA2_DNS_RESOLVER)) {
    throw new Error(`aria2 does not advertise the Firelink native resolver: ${JSON.stringify(version)}`);
  }
  if (!Array.isArray(version.firelinkNetworkTargetPolicies)
      || !version.firelinkNetworkTargetPolicies.includes(ARIA2_NETWORK_TARGET_POLICY)) {
    throw new Error(`aria2 does not advertise the Firelink target policy: ${JSON.stringify(version)}`);
  }
}

export function hasAria2RouteCapabilities(version) {
  try {
    assertAria2RouteCapabilities(version);
    return true;
  } catch {
    return false;
  }
}

export function assertAria2SystemResolverOptions(options, context = 'aria2 transfer') {
  if (options?.['async-dns'] !== 'false') {
    throw new Error(`${context} did not retain async-dns=false: ${JSON.stringify(options)}`);
  }
  if (Object.hasOwn(options || {}, 'dns-resolver')
      && options['dns-resolver'] !== ARIA2_DNS_RESOLVER) {
    throw new Error(`${context} retained an unknown resolver mode: ${JSON.stringify(options)}`);
  }
  if (Object.hasOwn(options || {}, 'network-target-policy')
      && options['network-target-policy'] !== 'none') {
    throw new Error(`${context} retained an active target policy: ${JSON.stringify(options)}`);
  }
}

export function assertAria2RouteContract(version) {
  assertAria2RouteCapabilities(version);
  const expected = {
    firelinkRevision: ARIA2_FIRELINK_REVISION,
    firelinkDnsResolver: ARIA2_DNS_RESOLVER,
    firelinkNetworkTargetPolicy: ARIA2_NETWORK_TARGET_POLICY,
    firelinkNetworkTargetPolicyDigest: ARIA2_NETWORK_TARGET_POLICY_DIGEST,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (version?.[field] !== value) {
      throw new Error(`aria2 route contract mismatch for ${field}: ${JSON.stringify(version)}`);
    }
  }
  if (version.firelinkNetworkTargetPolicyEnforced !== true) {
    throw new Error(`aria2 is not enforcing the Firelink network target policy: ${JSON.stringify(version)}`);
  }
}

export function assertAria2RouteOptions(options, context = 'aria2 transfer') {
  for (const [field, value] of Object.entries(ARIA2_ROUTE_OPTIONS)) {
    if (options?.[field] !== value) {
      throw new Error(`${context} did not retain ${field}=${value}: ${JSON.stringify(options)}`);
    }
  }
}

export function assertAria2RouteSource(source, target) {
  const contract = source?.firelinkRouteContract;
  const expected = {
    revision: ARIA2_FIRELINK_REVISION,
    dnsResolver: ARIA2_DNS_RESOLVER,
    networkTargetPolicy: ARIA2_NETWORK_TARGET_POLICY,
    networkTargetPolicyDigest: ARIA2_NETWORK_TARGET_POLICY_DIGEST,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (contract?.[field] !== value) {
      throw new Error(
        `aria2c source for ${target} is not a Firelink route-contract build; `
        + `expected firelinkRouteContract.${field}=${value}`,
      );
    }
  }
}

export function assertAria2AllocationCapabilities(version) {
  if (version?.firelinkAllocationTelemetry !== true) {
    throw new Error('Bundled Aria2 does not expose file allocation telemetry');
  }
}
