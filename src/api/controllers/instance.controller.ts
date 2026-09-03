import { InstanceDto, SetPresenceDto } from '@api/dto/instance.dto';
import { LogoutFailedError } from '@api/integrations/channel/whatsapp/errors/logout-failed.error';
import { ChatwootService } from '@api/integrations/chatbot/chatwoot/services/chatwoot.service';
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { channelController, eventManager } from '@api/server.module';
import { CacheService } from '@api/services/cache.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { SettingsService } from '@api/services/settings.service';
import { Events, Integration, wa } from '@api/types/wa.types';
import { Auth, Chatwoot, ConfigService, HttpServer, WaBusiness } from '@config/env.config';
import { Logger } from '@config/logger.config';
import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@exceptions';
import { delay } from 'baileys';
import { isArray, isURL } from 'class-validator';
import EventEmitter2 from 'eventemitter2';
import { v4 } from 'uuid';

import { ProxyController } from './proxy.controller';

export class InstanceController {
  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly configService: ConfigService,
    private readonly prismaRepository: PrismaRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly chatwootService: ChatwootService,
    private readonly settingsService: SettingsService,
    private readonly proxyService: ProxyController,
    private readonly cache: CacheService,
    private readonly chatwootCache: CacheService,
    private readonly baileysCache: CacheService,
    private readonly providerFiles: ProviderFiles,
  ) {}

  private readonly logger = new Logger('InstanceController');

  public async createInstance(instanceData: InstanceDto) {
    try {
      const instance = channelController.init(instanceData, {
        configService: this.configService,
        eventEmitter: this.eventEmitter,
        prismaRepository: this.prismaRepository,
        cache: this.cache,
        chatwootCache: this.chatwootCache,
        baileysCache: this.baileysCache,
        providerFiles: this.providerFiles,
      });

      if (!instance) {
        throw new BadRequestException('Invalid integration');
      }

      const instanceId = v4();

      instanceData.instanceId = instanceId;

      let hash: string;

      if (!instanceData.token) hash = v4().toUpperCase();
      else hash = instanceData.token;

      await this.waMonitor.saveInstance({
        instanceId,
        integration: instanceData.integration,
        instanceName: instanceData.instanceName,
        ownerJid: instanceData.ownerJid,
        profileName: instanceData.profileName,
        profilePicUrl: instanceData.profilePicUrl,
        hash,
        number: instanceData.number,
        businessId: instanceData.businessId,
        status: instanceData.status,
      });

      instance.setInstance({
        instanceName: instanceData.instanceName,
        instanceId,
        integration: instanceData.integration,
        token: hash,
        number: instanceData.number,
        businessId: instanceData.businessId,
      });

      this.waMonitor.waInstances[instance.instanceName] = instance;
      this.waMonitor.delInstanceTime(instance.instanceName);

      // set events
      await eventManager.setInstance(instance.instanceName, instanceData);

      instance.sendDataWebhook(Events.INSTANCE_CREATE, {
        instanceName: instanceData.instanceName,
        instanceId: instanceId,
      });

      const instanceDto: InstanceDto = {
        instanceName: instance.instanceName,
        instanceId: instance.instanceId,
        connectionStatus:
          typeof instance.connectionStatus === 'string'
            ? instance.connectionStatus
            : instance.connectionStatus?.state || 'unknown',
      };

      if (instanceData.proxyHost && instanceData.proxyPort && instanceData.proxyProtocol) {
        // Veredito DISCRIMINADO, nao o booleano (issue cnpjbiz#2457). O `testProxy()` era
        // `false` tambem quando a chamada de REFERENCIA falhava — e ai o icanhazip fora do ar
        // derrubava a criacao de conta com porta perfeita. So recusa quando a sonda prova que
        // o proxy nao serve; sem medida, segue e deixa a varredura de portas achar depois.
        const probe = await this.proxyService.testProxyEndpoint({
          host: instanceData.proxyHost,
          port: instanceData.proxyPort,
          protocol: instanceData.proxyProtocol,
          username: instanceData.proxyUsername,
          password: instanceData.proxyPassword,
        });
        if (ProxyController.PROVA_PROXY_RUIM.includes(probe.outcome)) {
          throw new BadRequestException('Invalid proxy');
        }
        if (!probe.ok) {
          this.logger.warn(`createInstance: proxy sem veredito da sonda (${probe.outcome}): ${probe.error}`);
        }
        await this.proxyService.createProxy(instanceDto, {
          enabled: true,
          host: instanceData.proxyHost,
          port: instanceData.proxyPort,
          protocol: instanceData.proxyProtocol,
          username: instanceData.proxyUsername,
          password: instanceData.proxyPassword,
        });
      }

      const settings: wa.LocalSettings = {
        rejectCall: instanceData.rejectCall === true,
        msgCall: instanceData.msgCall || '',
        groupsIgnore: instanceData.groupsIgnore === true,
        alwaysOnline: instanceData.alwaysOnline === true,
        readMessages: instanceData.readMessages === true,
        readStatus: instanceData.readStatus === true,
        syncFullHistory: instanceData.syncFullHistory === true,
        wavoipToken: instanceData.wavoipToken || '',
      };

      await this.settingsService.create(instanceDto, settings);

      let webhookWaBusiness = null,
        accessTokenWaBusiness = '';

      if (instanceData.integration === Integration.WHATSAPP_BUSINESS) {
        if (!instanceData.number) {
          throw new BadRequestException('number is required');
        }
        const urlServer = this.configService.get<HttpServer>('SERVER').URL;
        webhookWaBusiness = `${urlServer}/webhook/meta`;
        accessTokenWaBusiness = this.configService.get<WaBusiness>('WA_BUSINESS').TOKEN_WEBHOOK;
      }

      if (!instanceData.chatwootAccountId || !instanceData.chatwootToken || !instanceData.chatwootUrl) {
        let getQrcode: wa.QrCode;

        if (instanceData.qrcode && instanceData.integration === Integration.WHATSAPP_BAILEYS) {
          await instance.connectToWhatsapp(instanceData.number);
          await delay(5000);
          getQrcode = instance.qrCode;
        }

        const result = {
          instance: {
            instanceName: instance.instanceName,
            instanceId: instanceId,
            integration: instanceData.integration,
            webhookWaBusiness,
            accessTokenWaBusiness,
            status:
              typeof instance.connectionStatus === 'string'
                ? instance.connectionStatus
                : instance.connectionStatus?.state || 'unknown',
          },
          hash,
          webhook: {
            webhookUrl: instanceData?.webhook?.url,
            webhookHeaders: instanceData?.webhook?.headers,
            webhookByEvents: instanceData?.webhook?.byEvents,
            webhookBase64: instanceData?.webhook?.base64,
          },
          websocket: {
            enabled: instanceData?.websocket?.enabled,
          },
          rabbitmq: {
            enabled: instanceData?.rabbitmq?.enabled,
          },
          nats: {
            enabled: instanceData?.nats?.enabled,
          },
          sqs: {
            enabled: instanceData?.sqs?.enabled,
          },
          settings,
          qrcode: getQrcode,
        };

        return result;
      }

      if (!this.configService.get<Chatwoot>('CHATWOOT').ENABLED)
        throw new BadRequestException('Chatwoot is not enabled');

      if (!instanceData.chatwootAccountId) {
        throw new BadRequestException('accountId is required');
      }

      if (!instanceData.chatwootToken) {
        throw new BadRequestException('token is required');
      }

      if (!instanceData.chatwootUrl) {
        throw new BadRequestException('url is required');
      }

      if (!isURL(instanceData.chatwootUrl, { require_tld: false })) {
        throw new BadRequestException('Invalid "url" property in chatwoot');
      }

      if (instanceData.chatwootSignMsg !== true && instanceData.chatwootSignMsg !== false) {
        throw new BadRequestException('signMsg is required');
      }

      if (instanceData.chatwootReopenConversation !== true && instanceData.chatwootReopenConversation !== false) {
        throw new BadRequestException('reopenConversation is required');
      }

      if (instanceData.chatwootConversationPending !== true && instanceData.chatwootConversationPending !== false) {
        throw new BadRequestException('conversationPending is required');
      }

      const urlServer = this.configService.get<HttpServer>('SERVER').URL;

      try {
        this.chatwootService.create(instanceDto, {
          enabled: true,
          accountId: instanceData.chatwootAccountId,
          token: instanceData.chatwootToken,
          url: instanceData.chatwootUrl,
          signMsg: instanceData.chatwootSignMsg || false,
          nameInbox: instanceData.chatwootNameInbox ?? instance.instanceName.split('-cwId-')[0],
          number: instanceData.number,
          reopenConversation: instanceData.chatwootReopenConversation || false,
          conversationPending: instanceData.chatwootConversationPending || false,
          importContacts: instanceData.chatwootImportContacts ?? true,
          mergeBrazilContacts: instanceData.chatwootMergeBrazilContacts ?? false,
          importMessages: instanceData.chatwootImportMessages ?? true,
          daysLimitImportMessages: instanceData.chatwootDaysLimitImportMessages ?? 60,
          organization: instanceData.chatwootOrganization,
          logo: instanceData.chatwootLogo,
          autoCreate: instanceData.chatwootAutoCreate !== false,
        });
      } catch (error) {
        this.logger.log(error);
      }

      return {
        instance: {
          instanceName: instance.instanceName,
          instanceId: instanceId,
          integration: instanceData.integration,
          webhookWaBusiness,
          accessTokenWaBusiness,
          status:
            typeof instance.connectionStatus === 'string'
              ? instance.connectionStatus
              : instance.connectionStatus?.state || 'unknown',
        },
        hash,
        webhook: {
          webhookUrl: instanceData?.webhook?.url,
          webhookHeaders: instanceData?.webhook?.headers,
          webhookByEvents: instanceData?.webhook?.byEvents,
          webhookBase64: instanceData?.webhook?.base64,
        },
        websocket: {
          enabled: instanceData?.websocket?.enabled,
        },
        rabbitmq: {
          enabled: instanceData?.rabbitmq?.enabled,
        },
        nats: {
          enabled: instanceData?.nats?.enabled,
        },
        sqs: {
          enabled: instanceData?.sqs?.enabled,
        },
        settings,
        chatwoot: {
          enabled: true,
          accountId: instanceData.chatwootAccountId,
          token: instanceData.chatwootToken,
          url: instanceData.chatwootUrl,
          signMsg: instanceData.chatwootSignMsg || false,
          reopenConversation: instanceData.chatwootReopenConversation || false,
          conversationPending: instanceData.chatwootConversationPending || false,
          mergeBrazilContacts: instanceData.chatwootMergeBrazilContacts ?? false,
          importContacts: instanceData.chatwootImportContacts ?? true,
          importMessages: instanceData.chatwootImportMessages ?? true,
          daysLimitImportMessages: instanceData.chatwootDaysLimitImportMessages || 60,
          number: instanceData.number,
          nameInbox: instanceData.chatwootNameInbox ?? instance.instanceName,
          webhookUrl: `${urlServer}/chatwoot/webhook/${encodeURIComponent(instance.instanceName)}`,
        },
      };
    } catch (error) {
      this.waMonitor.deleteInstance(instanceData.instanceName);
      this.logger.error(isArray(error.message) ? error.message[0] : error.message);
      throw new BadRequestException(isArray(error.message) ? error.message[0] : error.message);
    }
  }

  public async connectToWhatsapp({ instanceName, number = null }: InstanceDto) {
    try {
      const instance = this.waMonitor.waInstances[instanceName];
      const state = instance?.connectionStatus?.state;

      if (!state) {
        throw new BadRequestException('The "' + instanceName + '" instance does not exist');
      }

      if (state == 'open') {
        return await this.connectionState({ instanceName });
      }

      if (state == 'connecting') {
        return instance.qrCode;
      }

      if (state == 'close') {
        await instance.connectToWhatsapp(number);

        await delay(2000);
        return instance.qrCode;
      }

      return {
        instance: {
          instanceName: instanceName,
          status: state,
        },
        qrcode: instance?.qrCode,
      };
    } catch (error) {
      this.logger.error(error);
      return { error: true, message: error.toString() };
    }
  }

  public async restartInstance({ instanceName }: InstanceDto) {
    try {
      const instance = this.waMonitor.waInstances[instanceName];
      const state = instance?.connectionStatus?.state;

      if (!state) {
        throw new BadRequestException('The "' + instanceName + '" instance does not exist');
      }

      if (state === 'close') {
        throw new BadRequestException('The "' + instanceName + '" instance is not connected');
      }
      this.logger.info(`Restarting instance: ${instanceName}`);

      if (typeof instance.restart === 'function') {
        await instance.restart();
        // Wait a bit for the reconnection to be established
        await new Promise((r) => setTimeout(r, 2000));
        return {
          instance: {
            instanceName: instanceName,
            status: instance.connectionStatus?.state || 'connecting',
          },
        };
      }

      // Fallback for Baileys (uses different mechanism)
      if (state === 'open' || state === 'connecting') {
        if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) instance.clearCacheChatwoot();

        // O caminho antigo (ws.close/end + connectToWhatsapp) era inócuo para o zumbi
        // profundo: com o client morto, close()/end() são no-op silencioso (optional
        // chaining), nenhum 'close' é emitido e o connectToWhatsapp retorna cedo porque o
        // estado segue preso em 'open'. Medido em produção (19/08/2026): instâncias 'open'
        // sem socket havia horas, e o restart só logava "Restarting instance" e retornava.
        //
        // reloadConnection() cria um socket NOVO incondicionalmente: createClient() faz o
        // teardown do client antigo (listeners, ws.close, end, fila de eventos drenada e
        // pausa de 500ms contra o 428 connectionReplaced), e um reconnect que o close do
        // socket velho tenha enfileirado é descartado pelo guard pós-fila do
        // scheduleReconnect() ("Connection already open again").
        if (typeof instance.reloadConnection === 'function') {
          await instance.reloadConnection();
          // Wait a bit for the reconnection to be established
          await new Promise((r) => setTimeout(r, 2000));

          return {
            instance: {
              instanceName: instanceName,
              status: instance.connectionStatus?.state || 'connecting',
            },
          };
        }

        instance.client?.ws?.close();
        instance.client?.end(new Error('restart'));
        // end() emits the 'close' connection.update asynchronously. Without
        // waiting for it, connectToWhatsapp reads the stale 'open' and returns
        // early — the caller gets a 200 with state 'open' and no QR even though
        // the socket is already dead (zombie restart, incident 2026-08-17).
        for (let i = 0; i < 10 && instance.connectionStatus?.state === 'open'; i++) {
          await new Promise((r) => setTimeout(r, 300));
        }
        return await this.connectToWhatsapp({ instanceName });
      }

      return {
        instance: {
          instanceName: instanceName,
          status: state,
        },
      };
    } catch (error) {
      this.logger.error(error);
      return { error: true, message: error.toString() };
    }
  }

  public async connectionState({ instanceName }: InstanceDto) {
    this.logger.error(this.waMonitor.waInstances[instanceName]?.connectionStatus);

    return {
      instance: {
        instanceName: instanceName,
        state: this.waMonitor.waInstances[instanceName]?.connectionStatus?.state,
      },
    };
  }

  public async fetchInstances({ instanceName, instanceId, number }: InstanceDto, key: string) {
    const env = this.configService.get<Auth>('AUTHENTICATION').API_KEY;

    if (env.KEY !== key) {
      const instancesByKey = await this.prismaRepository.instance.findMany({
        where: {
          token: key,
          name: instanceName || undefined,
          id: instanceId || undefined,
        },
      });

      if (instancesByKey.length > 0) {
        const names = instancesByKey.map((instance) => instance.name);

        return this.waMonitor.instanceInfo(names);
      } else {
        throw new UnauthorizedException();
      }
    }

    if (instanceId || number) {
      return this.waMonitor.instanceInfoById(instanceId, number);
    }

    const instanceNames = instanceName ? [instanceName] : null;

    return this.waMonitor.instanceInfo(instanceNames);
  }

  public async setPresence({ instanceName }: InstanceDto, data: SetPresenceDto) {
    return await this.waMonitor.waInstances[instanceName].setPresence(data);
  }

  /**
   * Desvincula o dispositivo no WhatsApp.
   *
   * Falha de logout devolve 409 (nao 500 nem `SUCCESS` falso): a instancia segue de pe com
   * as credenciais intactas e a operacao pode ser repetida quando o socket estabilizar.
   * Antes desta issue (cnpjbiz#2433) `logoutInstance()` engolia a excecao e este metodo
   * devolvia `SUCCESS` — o `catch` nunca disparava.
   */
  public async logout({ instanceName }: InstanceDto) {
    const { instance } = await this.connectionState({ instanceName });

    if (instance.state === 'close') {
      throw new BadRequestException('The "' + instanceName + '" instance is not connected');
    }

    try {
      await this.waMonitor.waInstances[instanceName]?.logoutInstance();

      return { status: 'SUCCESS', error: false, response: { message: 'Instance logged out' } };
    } catch (error) {
      if (error instanceof LogoutFailedError) {
        throw new ConflictException(error.message);
      }

      throw new InternalServerErrorException(error.toString());
    }
  }

  /**
   * Apaga a instancia — e SO apaga depois de o WhatsApp confirmar a remocao do dispositivo.
   *
   * Regras (issue cnpjbiz#2433):
   * - `connecting`: recusa com 409. O socket esta no meio do handshake, o logout falharia
   *   com `428 Connection Closed` e o dispositivo ficaria orfao. Foi exatamente o estado do
   *   caso medido em 21/08/2026.
   * - `open`: faz logout; se o logout falhar, ABORTA e devolve 409 — a instancia e as
   *   credenciais ficam preservadas para a proxima tentativa.
   * - `force=true`: apaga de qualquer forma, registrando em WARN que um dispositivo orfao
   *   pode ter sido criado. Necessario para os quadros em que o logout e impossivel por
   *   definicao — conta banida (403) ou aparelho fora do ar (ver cnpjbiz#2427).
   *
   * Apagar deixando orfao deixa de ser o comportamento padrao e silencioso.
   */
  public async deleteInstance({ instanceName, force }: InstanceDto) {
    const { instance } = await this.connectionState({ instanceName });
    const forced = force === true || (force as unknown as string) === 'true';

    if (instance.state === 'connecting' && !forced) {
      throw new ConflictException(
        `logout_failed: a instancia "${instanceName}" esta em 'connecting' (handshake em andamento). ` +
          'Apagar agora deixaria um dispositivo orfao na conta do cliente. Tente novamente em alguns segundos ' +
          'ou repita com force=true para aceitar o orfao.',
      );
    }

    try {
      const waInstances = this.waMonitor.waInstances[instanceName];
      if (this.configService.get<Chatwoot>('CHATWOOT').ENABLED) waInstances?.clearCacheChatwoot();

      if (instance.state === 'connecting' || instance.state === 'open') {
        try {
          await this.logout({ instanceName });
        } catch (error) {
          if (!forced) {
            throw error;
          }

          // `ownerJid`/`wuid` identificam o NUMERO afetado, nao so o hash da instancia: um
          // orfao e irreversivel, e sem o numero no log ninguem descobre depois qual conta de
          // qual cliente ficou com o dispositivo preso. Este WARN e a unica trilha de
          // auditoria de um `force` — inclusive se ele vier de um falso positivo de quem
          // chamou (ex.: takeover de numero classificado errado).
          this.logger.warn({
            message: 'force=true: instancia apagada apesar da falha de logout — DISPOSITIVO ORFAO na conta do cliente',
            instanceName,
            instanceId: waInstances?.instanceId,
            ownerJid: waInstances?.instance?.ownerJid,
            wuid: waInstances?.instance?.wuid,
            number: waInstances?.instance?.number,
            state: instance.state,
            errorMessage: error?.message ?? String(error),
          });
        }
      }

      try {
        waInstances?.sendDataWebhook(Events.INSTANCE_DELETE, {
          instanceName,
          instanceId: waInstances.instanceId,
        });
      } catch (error) {
        this.logger.error(error);
      }

      this.eventEmitter.emit('remove.instance', instanceName, 'inner');
      return { status: 'SUCCESS', error: false, response: { message: 'Instance deleted' } };
    } catch (error) {
      // 409 do logout falho sobe intacto: virar 400 aqui apagaria a distincao entre
      // "nao apaguei para nao criar orfao" (retentavel) e erro de requisicao.
      // 409 literal de proposito: importar HttpStatus de '@api/routes/index.router' fecharia
      // um ciclo index.router -> instance.router -> server.module -> este controller.
      if (error?.status === 409) {
        throw error;
      }

      throw new BadRequestException(error.toString());
    }
  }
}
