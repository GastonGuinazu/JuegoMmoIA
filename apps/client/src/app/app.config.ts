import { APP_INITIALIZER, ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { WorldMapLoaderService } from './game/world-map-loader.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideHttpClient(withFetch()),
    provideRouter(routes),
    {
      provide: APP_INITIALIZER,
      useFactory: (maps: WorldMapLoaderService) => () => maps.loadCatalog(),
      deps: [WorldMapLoaderService],
      multi: true,
    },
  ],
};
