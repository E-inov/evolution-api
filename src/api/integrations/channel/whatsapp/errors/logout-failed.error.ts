/**
 * O pedido de logout NAO chegou ao WhatsApp: `client.logout()` falhou (tipicamente
 * `428 Connection Closed`, quando o socket ainda nao completou o handshake).
 *
 * Existe para que o delete da instancia possa ABORTAR. Apagar as credenciais locais sem
 * ter removido o dispositivo no servidor do WhatsApp deixa um companion registrado para
 * sempre na conta do cliente (issue cnpjbiz#2433) — dano permanente e irreversivel: nao
 * ha API para remover o dispositivo depois, e cada orfao empurra a conta para o quadro
 * `401 device_removed` a cada ~53s apos parear.
 *
 * O marcador `logout_failed` na mensagem e contrato com o CRM, que o detecta para nao
 * apagar a conta local e pedir nova tentativa (EvolutionErrorClassifier::isLogoutFailed).
 */
export class LogoutFailedError extends Error {
  public readonly instanceName: string;
  public readonly statusCode?: number;

  constructor(instanceName: string, cause?: any) {
    const detail = cause?.output?.statusCode ?? cause?.message ?? 'unknown';

    super(
      `logout_failed: o WhatsApp nao confirmou a remocao do dispositivo da instancia "${instanceName}" (${detail})`,
    );

    this.name = 'LogoutFailedError';
    this.instanceName = instanceName;
    this.statusCode = cause?.output?.statusCode;
  }
}
