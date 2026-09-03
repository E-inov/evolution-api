import { RouterBroker } from '@api/abstract/abstract.router';
import { InstanceDto } from '@api/dto/instance.dto';
import { ProxyDto } from '@api/dto/proxy.dto';
import { proxyController } from '@api/server.module';
import { instanceSchema, proxySchema, proxyTestSchema } from '@validate/validate.schema';
import { RequestHandler, Router } from 'express';

import { HttpStatus } from './index.router';

export class ProxyRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router
      .post(this.routerPath('set'), ...guards, async (req, res) => {
        const response = await this.dataValidate<ProxyDto>({
          request: req,
          schema: proxySchema,
          ClassRef: ProxyDto,
          execute: (instance, data) => proxyController.createProxy(instance, data),
        });

        res.status(HttpStatus.CREATED).json(response);
      })
      .get(this.routerPath('find'), ...guards, async (req, res) => {
        const response = await this.dataValidate<InstanceDto>({
          request: req,
          schema: instanceSchema,
          ClassRef: InstanceDto,
          execute: (instance) => proxyController.findProxy(instance),
        });

        res.status(HttpStatus.OK).json(response);
      })
      // Sonda de porta, SEM `:instanceName` (issue cnpjbiz#2457): e operacao de HOST, nao
      // de instancia — quem sonda quer saber se a porta esta viva PELA ROTA DESTE DROPLET,
      // inclusive para portas livres do pool, que nao pertencem a instancia nenhuma.
      // Amarrar a rota a uma instancia obrigaria o chamador a inventar um nome so para
      // passar pelo guard, e a sonda quebraria quando aquela instancia fosse apagada.
      // O `instanceExistsGuard` isenta este caminho pelo mesmo motivo que ja isenta o
      // `fetchInstances`; o `authGuard` continua exigindo a apikey global.
      .post(this.routerPath('test', false), ...guards, async (req, res) => {
        const response = await this.dataValidate<ProxyDto>({
          request: req,
          schema: proxyTestSchema,
          ClassRef: ProxyDto,
          execute: (_, data) => proxyController.testProxyEndpoint(data),
        });

        res.status(HttpStatus.OK).json(response);
      });
  }

  public readonly router: Router = Router();
}
