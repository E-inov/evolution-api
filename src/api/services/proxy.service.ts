import { InstanceDto } from '@api/dto/instance.dto';
import { ProxyDto } from '@api/dto/proxy.dto';
import { Logger } from '@config/logger.config';
import { Proxy } from '@prisma/client';

import { WAMonitoringService } from './monitor.service';

export class ProxyService {
  constructor(private readonly waMonitor: WAMonitoringService) {}

  private readonly logger = new Logger('ProxyService');

  /**
   * `await` NAO e detalhe (issue cnpjbiz#2457): sem ele a rejeicao do Prisma virava
   * unhandled rejection e o `POST /proxy/set` respondia **201 com a porta nova no corpo
   * sem ter gravado nada**. O unico rastro era `Argument 'username' is missing` no
   * evolution-api-error.log. Quem trocava porta lendo a resposta reiniciava a instancia
   * confiante e a devolvia na porta VELHA — pior que nao ter trocado, porque derruba a
   * sessao a toa.
   */
  public async create(instance: InstanceDto, data: ProxyDto) {
    await this.waMonitor.waInstances[instance.instanceName].setProxy(data);

    return { proxy: { ...instance, proxy: data } };
  }

  public async find(instance: InstanceDto): Promise<Proxy> {
    try {
      const result = await this.waMonitor.waInstances[instance.instanceName].findProxy();

      if (Object.keys(result).length === 0) {
        throw new Error('Proxy not found');
      }

      return result;
    } catch {
      return null;
    }
  }
}
