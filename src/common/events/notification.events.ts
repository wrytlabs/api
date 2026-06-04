export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

export class NotificationEvent {
  constructor(
    public readonly namespaceId: string,
    public readonly title: string,
    public readonly message: string,
    public readonly level: NotificationLevel = 'info',
  ) {}
}

export class AdminNotificationEvent {
  constructor(
    public readonly title: string,
    public readonly message: string,
    public readonly level: NotificationLevel = 'info',
  ) {}
}
