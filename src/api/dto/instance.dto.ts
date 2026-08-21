import { IntegrationDto } from '@api/integrations/integration.dto';
import { JsonValue } from '@prisma/client/runtime/library';
import { WAPresence } from 'baileys';

export class InstanceDto extends IntegrationDto {
  instanceName: string;
  instanceId?: string;
  qrcode?: boolean;
  businessId?: string;
  number?: string;
  integration?: string;
  token?: string;
  status?: string;
  ownerJid?: string;
  connectionStatus?: string;
  profileName?: string;
  profilePicUrl?: string;
  // settings
  rejectCall?: boolean;
  msgCall?: string;
  groupsIgnore?: boolean;
  alwaysOnline?: boolean;
  readMessages?: boolean;
  readStatus?: boolean;
  syncFullHistory?: boolean;
  wavoipToken?: string;
  // proxy
  proxyHost?: string;
  proxyPort?: string;
  proxyProtocol?: string;
  proxyUsername?: string;
  proxyPassword?: string;
  webhook?: {
    enabled?: boolean;
    events?: string[];
    headers?: JsonValue;
    url?: string;
    byEvents?: boolean;
    base64?: boolean;
  };
  chatwootAccountId?: string;
  chatwootConversationPending?: boolean;
  chatwootAutoCreate?: boolean;
  chatwootDaysLimitImportMessages?: number;
  chatwootImportContacts?: boolean;
  chatwootImportMessages?: boolean;
  chatwootLogo?: string;
  chatwootMergeBrazilContacts?: boolean;
  chatwootNameInbox?: string;
  chatwootOrganization?: string;
  chatwootReopenConversation?: boolean;
  chatwootSignMsg?: boolean;
  chatwootToken?: string;
  chatwootUrl?: string;
  /**
   * `DELETE /instance/delete/:instance?force=true` — aceita apagar a instancia mesmo que o
   * logout falhe, assumindo o dispositivo orfao na conta do cliente. Sem isso o delete
   * ABORTA quando o WhatsApp nao confirma a remocao (issue cnpjbiz#2433). Query param chega
   * como string via `dataValidate`, entao 'true' tambem vale.
   */
  force?: boolean;
}

export class SetPresenceDto {
  presence: WAPresence;
}
