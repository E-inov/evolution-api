import { InstanceDto } from '@api/dto/instance.dto';
import { cache, prismaRepository, waMonitor } from '@api/server.module';
import { CacheConf, configService } from '@config/env.config';
import { BadRequestException, ForbiddenException, InternalServerErrorException, NotFoundException } from '@exceptions';
import { NextFunction, Request, Response } from 'express';

async function getInstance(instanceName: string) {
  try {
    const cacheConf = configService.get<CacheConf>('CACHE');

    const exists = !!waMonitor.waInstances[instanceName];

    if (cacheConf.REDIS.ENABLED && cacheConf.REDIS.SAVE_INSTANCES) {
      const keyExists = await cache.has(instanceName);

      return exists || keyExists;
    }

    return exists || (await prismaRepository.instance.findMany({ where: { name: instanceName } })).length > 0;
  } catch (error) {
    throw new InternalServerErrorException(error?.toString());
  }
}

/**
 * O pedido e a sonda de porta (`POST /proxy/test`), em qualquer grafia que o Express aceite?
 *
 * Barras repetidas viram uma so, barra final e ignorada e a comparacao e minuscula — as tres
 * variacoes alcancam a rota, entao as tres precisam da mesma isencao.
 */
function isProxyTestPath(req: Request): boolean {
  const caminho = `${req.baseUrl}${req.path}`
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');

  return caminho === '/proxy/test';
}

export async function instanceExistsGuard(req: Request, _: Response, next: NextFunction) {
  if (req.originalUrl.includes('/instance/create') || req.originalUrl.includes('/instance/fetchInstances')) {
    return next();
  }

  // `POST /proxy/test` sonda uma porta a partir DESTE host e nao pertence a instancia
  // nenhuma — inclusive sonda portas livres do pool (issue cnpjbiz#2457). Mesma isencao
  // do `fetchInstances`, que tambem e operacao de host.
  //
  // Casamento pelo caminho NORMALIZADO do router, nao por `endsWith` no `originalUrl`: o
  // Express e non-strict e case-insensitive, entao `/proxy/test/`, `/proxy/TEST` e
  // `/proxy//test` alcancam a MESMA rota — e com o `endsWith` elas passavam pelo guard e
  // morriam em 400 `"instanceName" not provided.`, um 400 que ninguem consegue explicar.
  // `req.baseUrl` + `req.path` tambem ignoram a query string por construcao.
  if (isProxyTestPath(req)) {
    return next();
  }

  const param = req.params as unknown as InstanceDto;
  if (!param?.instanceName) {
    throw new BadRequestException('"instanceName" not provided.');
  }

  if (!(await getInstance(param.instanceName))) {
    throw new NotFoundException(`The "${param.instanceName}" instance does not exist`);
  }

  next();
}

export async function instanceLoggedGuard(req: Request, _: Response, next: NextFunction) {
  if (req.originalUrl.includes('/instance/create')) {
    const instance = req.body as InstanceDto;
    if (await getInstance(instance.instanceName)) {
      throw new ForbiddenException(`This name "${instance.instanceName}" is already in use.`);
    }

    if (waMonitor.waInstances[instance.instanceName]) {
      delete waMonitor.waInstances[instance.instanceName];
    }
  }

  next();
}
