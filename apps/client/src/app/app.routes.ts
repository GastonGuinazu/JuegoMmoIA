import { Routes } from '@angular/router';
import { GameViewportComponent } from './game/game-viewport.component';
import { LoginPageComponent } from './login/login-page.component';
import { redirectIfAuthenticatedGuard, requireCharacterGuard } from './login/auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginPageComponent, canActivate: [redirectIfAuthenticatedGuard] },
  { path: '', component: GameViewportComponent, canActivate: [requireCharacterGuard] },
  { path: '**', redirectTo: '' },
];
