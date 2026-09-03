import { InstanceDto } from '@api/dto/instance.dto';
import { ProxyDto } from '@api/dto/proxy.dto';
import { WAMonitoringService } from '@api/services/monitor.service';
import { ProxyService } from '@api/services/proxy.service';
import { Logger } from '@config/logger.config';
import { BadRequestException, NotFoundException } from '@exceptions';
import { makeProxyAgent } from '@utils/makeProxyAgent';
import axios from 'axios';

const logger = new Logger('ProxyController');

/**
 * Resultado DISCRIMINADO da sonda de proxy (issue cnpjbiz#2457).
 *
 * `ok` sozinho nao serve para decidir quarentena: o `testProxy()` antigo devolvia
 * `false` no `catch` de QUALQUER erro, inclusive o da chamada de referencia SEM proxy.
 * Com isso "porta morta" e "icanhazip fora do ar" ficavam indistinguiveis — e uma
 * varredura automatica que confiasse nesse booleano marcaria o POOL INTEIRO como morto
 * durante uma queda do endpoint de referencia, deixando o `newProxy` do CRM sem nenhuma
 * porta para entregar. Por isso o `outcome`.
 */
export type ProxyProbeOutcome =
  /** A porta responde e o IP de saida e outro: proxy funcionando. */
  | 'ok'
  /** A porta responde mas o IP de saida e o do proprio droplet: proxy nao esta roteando. */
  | 'same_origin_ip'
  /**
   * Nao conseguimos NEM FALAR com o proxy: e o unico veredito que sustenta "porta morta".
   *
   * Estreito de proposito. Antes este outcome absorvia tambem config invalida e proxy que
   * RESPONDEU recusando — e ai bastava o droplet sair da allowlist do fornecedor para toda
   * porta voltar `proxy_unreachable` e a varredura quarentenar o pool inteiro. Era o mesmo
   * desastre que o `reference_unreachable` existe para evitar, entrando por outra porta.
   */
  | 'proxy_unreachable'
  /**
   * O proxy RESPONDEU com erro HTTP (tipicamente 407, autenticacao/allowlist). A porta esta
   * viva; o que falhou foi a credencial ou o IP de origem. Nao e veredito sobre a porta.
   */
  | 'proxy_refused'
  /**
   * Nem chegamos a tentar: protocolo/porta invalidos no proprio pedido. Defeito de
   * configuracao nossa, nunca da porta.
   */
  | 'invalid_config'
  /** A chamada DIRETA falhou: nao medimos nada sobre a porta. Nao conclua nada daqui. */
  | 'reference_unreachable';

export type ProxyProbeResult = {
  ok: boolean;
  outcome: ProxyProbeOutcome;
  /** IP visto atraves do proxy, quando houve resposta. */
  exitIp: string | null;
  /** IP do proprio droplet, quando a chamada de referencia respondeu. */
  originIp: string | null;
  /** Latencia da chamada PELO proxy, em ms. `null` quando ela nao chegou a acontecer. */
  latencyMs: number | null;
  /** Latencia da chamada de referencia, em ms. Serve para separar "rede do host ruim". */
  referenceLatencyMs: number | null;
  /** Status HTTP com que o PROXY respondeu, quando ele respondeu. 407 = allowlist/credencial. */
  proxyHttpStatus: number | null;
  error: string | null;
};

export class ProxyController {
  /**
   * Sem timeout, o axios espera indefinidamente e a sonda deixa de ser sonda: em host
   * sob carga (onda de 500, memoria apertada) a chamada travada devolvia `false` tarde
   * demais e o `createProxy` recusava proxy BOM com "Invalid proxy".
   */
  private static readonly PROBE_TIMEOUT_MS = 15000;

  private static readonly REFERENCE_URL = 'https://icanhazip.com/';

  /**
   * Outcomes que PROVAM que este proxy nao serve para a instancia. Recusar por qualquer outra
   * coisa era o falso positivo conhecido: uma lentidao do endereco de referencia bloqueava
   * provisionamento de conta com porta perfeita.
   */
  public static readonly PROVA_PROXY_RUIM: ProxyProbeOutcome[] = [
    'proxy_unreachable',
    'same_origin_ip',
    'invalid_config',
    'proxy_refused',
  ];

  constructor(
    private readonly proxyService: ProxyService,
    private readonly waMonitor: WAMonitoringService,
  ) {}

  public async createProxy(instance: InstanceDto, data: ProxyDto) {
    if (!this.waMonitor.waInstances[instance.instanceName]) {
      throw new NotFoundException(`The "${instance.instanceName}" instance does not exist`);
    }

    if (!data?.enabled) {
      data.host = '';
      data.port = '';
      data.protocol = '';
      data.username = '';
      data.password = '';
    }

    if (data.host) {
      const probe = await this.probeProxy(data);

      // So recusa quando a sonda PROVA que o proxy esta ruim. `reference_unreachable`
      // significa que a chamada direta (sem proxy) falhou — nao ha medida nenhuma sobre
      // a porta, e reprovar ali era o falso positivo conhecido: uma lentidao do
      // icanhazip.com bloqueava provisionamento de conta com porta perfeita.
      if (ProxyController.PROVA_PROXY_RUIM.includes(probe.outcome)) {
        throw new BadRequestException('Invalid proxy');
      }

      if (!probe.ok) {
        logger.warn(`createProxy: seguindo sem veredito da sonda (${probe.outcome}): ${probe.error}`);
      }
    }

    return this.proxyService.create(instance, data);
  }

  public async findProxy(instance: InstanceDto) {
    if (!this.waMonitor.waInstances[instance.instanceName]) {
      throw new NotFoundException(`The "${instance.instanceName}" instance does not exist`);
    }

    return this.proxyService.find(instance);
  }

  /**
   * Sonda uma porta de proxy A PARTIR DESTE HOST, sem tocar em instancia nenhuma.
   *
   * Existe porque quem decide trocar a porta de um cliente e o `schedule:run` do Laravel,
   * que roda no LB — e o LB **nao esta na allowlist por IP** do fornecedor de proxy, que
   * so libera os 4 droplets da Evolution. Sondar de la mediria a rota errada e daria
   * "morta" para porta viva. Alem disso a porta pode responder de um droplet e nao de
   * outro, entao a sonda tem de sair do host onde a instancia roda.
   */
  public async testProxyEndpoint(data: ProxyDto): Promise<ProxyProbeResult> {
    return this.probeProxy(data);
  }

  /**
   * Compatibilidade: o veredito booleano de sempre. Mantido porque a semantica "true =
   * pode usar" e o que os chamadores antigos esperam. Codigo novo deve usar
   * {@link probeProxy} e olhar o `outcome`.
   */
  public async testProxy(proxy: ProxyDto): Promise<boolean> {
    return (await this.probeProxy(proxy)).ok;
  }

  /**
   * ORDEM IMPORTA: a chamada de referencia vem primeiro e, se ela falhar, a sonda para
   * ali com `reference_unreachable`. Sem essa separacao nao ha como distinguir "a porta
   * morreu" de "o endereco de referencia esta fora", que e a diferenca entre quarentenar
   * uma porta e quarentenar o pool inteiro.
   */
  private async probeProxy(proxy: ProxyDto): Promise<ProxyProbeResult> {
    const base: ProxyProbeResult = {
      ok: false,
      outcome: 'reference_unreachable',
      exitIp: null,
      originIp: null,
      latencyMs: null,
      referenceLatencyMs: null,
      proxyHttpStatus: null,
      error: null,
    };

    // O agent e construido ANTES de qualquer chamada, e fora do try do proxy, porque
    // `makeProxyAgent` LANCA para protocolo nao suportado e para porta que nao forma URL
    // valida. Dentro do try, esses erros viravam `proxy_unreachable` — ou seja, um typo
    // nosso no pedido virava veredito de "porta morta" e, com N deles, quarentena de porta
    // boa. Aqui a config invalida falha em outcome proprio e sem gastar chamada nenhuma.
    let agent: ReturnType<typeof makeProxyAgent>;

    try {
      agent = makeProxyAgent(proxy);
    } catch (error) {
      logger.error('probeProxy: configuracao invalida: ' + ProxyController.describeError(error));

      return { ...base, outcome: 'invalid_config', error: ProxyController.describeError(error) };
    }

    const referenceStartedAt = Date.now();
    let originIp: string;

    try {
      const serverIp = await axios.get(ProxyController.REFERENCE_URL, {
        timeout: ProxyController.PROBE_TIMEOUT_MS,
      });

      originIp = ProxyController.normalizeIp(serverIp?.data);
    } catch (error) {
      logger.error('probeProxy: referencia inalcancavel: ' + ProxyController.describeError(error));

      return {
        ...base,
        referenceLatencyMs: Date.now() - referenceStartedAt,
        error: ProxyController.describeError(error),
      };
    }

    const referenceLatencyMs = Date.now() - referenceStartedAt;
    const proxyStartedAt = Date.now();

    try {
      const response = await axios.get(ProxyController.REFERENCE_URL, {
        httpsAgent: agent,
        timeout: ProxyController.PROBE_TIMEOUT_MS,
      });

      const exitIp = ProxyController.normalizeIp(response?.data);
      const latencyMs = Date.now() - proxyStartedAt;

      // Porta que RESPONDE devolvendo o IP do proprio droplet nao esta morta — esta
      // sem rotear. Sao problemas diferentes, com condutas diferentes, e misturar os
      // dois no mesmo `false` estragaria a calibragem do N sondas da quarentena.
      if (exitIp === originIp) {
        logger.warn("probeProxy: proxy connection doesn't change the origin IP");

        return { ...base, outcome: 'same_origin_ip', exitIp, originIp, latencyMs, referenceLatencyMs };
      }

      logger.info('probeProxy: proxy connection successful');

      return {
        ok: true,
        outcome: 'ok',
        exitIp,
        originIp,
        latencyMs,
        referenceLatencyMs,
        proxyHttpStatus: null,
        error: null,
      };
    } catch (error) {
      // Se veio RESPOSTA HTTP, o proxy esta vivo e falando: o que falhou foi credencial ou
      // allowlist de IP (tipicamente 407), nao a porta. Tratar isso como porta morta e o que
      // permitiria a queda da allowlist do fornecedor quarentenar o pool INTEIRO de uma vez.
      const proxyHttpStatus = axios.isAxiosError(error) ? (error.response?.status ?? null) : null;

      logger.error('probeProxy: proxy nao serviu: ' + ProxyController.describeError(error));

      return {
        ...base,
        outcome: proxyHttpStatus === null ? 'proxy_unreachable' : 'proxy_refused',
        originIp,
        latencyMs: Date.now() - proxyStartedAt,
        referenceLatencyMs,
        proxyHttpStatus,
        error: ProxyController.describeError(error),
      };
    }
  }

  /** O icanhazip devolve o IP com `\n`; comparar sem normalizar nunca casaria. */
  private static normalizeIp(data: unknown): string {
    return typeof data === 'string' ? data.trim() : String(data ?? '').trim();
  }

  private static describeError(error: unknown): string {
    if (axios.isAxiosError(error)) {
      // O status entra na mensagem: sem ele, `Request failed with status code 407` e
      // `ECONNREFUSED` ficavam indistinguiveis em quem so lesse o texto do erro.
      const status = error.response?.status;

      return `${error.code ?? 'axios'}${status ? ` (HTTP ${status})` : ''}: ${error.message}`;
    }

    return String(error);
  }
}
