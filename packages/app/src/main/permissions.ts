import type { Session } from 'electron';

/**
 * The web platform's permissions (plan 9, D8): Cirrus asks for none — no camera, microphone, notification, position,
 * clipboard read, fullscreen of an element, MIDI, device —, so every request is refused, every check answers no, and
 * no device is granted. Copy and paste go through the editors' own events, which ask no permission; the bench's full
 * screen is the window's (BrowserWindow), not the page's.
 */
export function refuseAllPermissions(session: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler'>): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
}
