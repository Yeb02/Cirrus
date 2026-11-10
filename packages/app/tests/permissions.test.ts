import { expect, test } from 'vitest';
import { refuseAllPermissions } from '../src/main/permissions.ts';

// The app's hardening (plan 9, D8): Cirrus asks for no permission of the web platform, so every one is refused — asked
// (a request) or merely checked — and no device (HID, série, USB) is ever granted.
const PERMISSIONS = [
  'media', 'notifications', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'midi', 'midiSysex',
  'pointerLock', 'keyboardLock', 'openExternal', 'display-capture', 'idle-detection', 'storage-access', 'window-management',
  'hid', 'serial', 'usb', 'unknown',
];

type RequestHandler = (wc: unknown, permission: string, callback: (granted: boolean) => void, details: unknown) => void;
type CheckHandler = (wc: unknown, permission: string, origin: string, details: unknown) => boolean;
type DeviceHandler = (details: unknown) => boolean;

function fakeSession() {
  const set: { request?: RequestHandler; check?: CheckHandler; device?: DeviceHandler } = {};
  return {
    set,
    setPermissionRequestHandler: (h: RequestHandler) => { set.request = h; },
    setPermissionCheckHandler: (h: CheckHandler) => { set.check = h; },
    setDevicePermissionHandler: (h: DeviceHandler) => { set.device = h; },
  };
}

test('toute demande de permission est refusée, une seule réponse chaque fois', () => {
  const session = fakeSession();
  refuseAllPermissions(session as never);
  expect(session.set.request).toBeTypeOf('function');
  for (const permission of PERMISSIONS) {
    const answers: boolean[] = [];
    session.set.request!(null, permission, (granted) => answers.push(granted), { requestingUrl: 'file:///index.html' });
    expect(answers, permission).toEqual([false]);
  }
});

test('toute vérification de permission répond non', () => {
  const session = fakeSession();
  refuseAllPermissions(session as never);
  for (const permission of PERMISSIONS) expect(session.set.check!(null, permission, 'file:///', {}), permission).toBe(false);
});

test('aucun périphérique n’est accordé', () => {
  const session = fakeSession();
  refuseAllPermissions(session as never);
  for (const deviceType of ['hid', 'serial', 'usb']) expect(session.set.device!({ deviceType, origin: 'file://', device: {} })).toBe(false);
});
