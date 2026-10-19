// Root component: providers + route table. Pages are lazy-loaded per feature.

import { QueryClientProvider } from '@tanstack/react-query';
import { type ComponentType } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { takeLinkTokenFromAddress } from '../lib/linkToken';
import { AuthedApp } from './AuthedApp';
import { retryableLazy } from './chunkErrors';
import { DirectoryLayout } from './DirectoryLayout';
import { HomeRedirect, LegacySpaceRedirect } from './HomeRedirect';
import { LEGACY_SPACE_ROUTES } from './legacyRedirect';
import { queryClient } from './queryClient';
import { PublicOnly } from './PublicOnly';
import { PublicPage } from './PublicPage';
import { RouteError } from './RouteError';
import { SpaceLayout } from './SpaceLayout';

/** A lazy-loaded page whose chunk is imported again after a failed load (offline, upgrade). */
function lazyPage(load: () => Promise<{ default: ComponentType }>): ComponentType {
  const loader = retryableLazy(load);
  return function LazyPage() {
    const Page = loader.current();
    return <Page />;
  };
}

const LoginPage = lazyPage(() => import('../features/auth/LoginPage'));
const SetupPage = lazyPage(() => import('../features/auth/SetupPage'));
const SignupPage = lazyPage(() => import('../features/auth/SignupPage'));
const SignupCompletePage = lazyPage(() => import('../features/auth/SignupCompletePage'));
const ForgotPasswordPage = lazyPage(() => import('../features/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazyPage(() => import('../features/auth/ResetPasswordPage'));
const EmailConfirmPage = lazyPage(() => import('../features/auth/EmailConfirmPage'));
const RecoverPage = lazyPage(() => import('../features/auth/RecoverPage'));
const InvitePage = lazyPage(() => import('../features/invitations/InvitePage'));
const SpacesPage = lazyPage(() => import('../features/spaces/SpacesPage'));
const ImportPage = lazyPage(() => import('../features/import/ImportPage'));
const AccountSettingsLayout = lazyPage(() => import('../features/settings/AccountSettingsLayout'));
const AccountSettings = lazyPage(() => import('../features/settings/AccountSettings'));
const SecuritySettings = lazyPage(() => import('../features/settings/SecuritySettings'));
const PreferencesSettings = lazyPage(() => import('../features/settings/PreferencesSettings'));
const AccountDangerSettings = lazyPage(() => import('../features/settings/AccountDangerSettings'));
const AdminLayout = lazyPage(() => import('../features/admin/AdminLayout'));
const AdminOverview = lazyPage(() => import('../features/admin/AdminOverview'));
const AdminSettings = lazyPage(() => import('../features/admin/AdminSettings'));
const AdminUsers = lazyPage(() => import('../features/admin/AdminUsers'));
const AdminUserDetail = lazyPage(() => import('../features/admin/AdminUserDetail'));
const AdminInvitations = lazyPage(() => import('../features/admin/AdminInvitations'));
const AdminSpaces = lazyPage(() => import('../features/admin/AdminSpaces'));
const SpaceHome = lazyPage(() => import('../features/home/SpaceHome'));
const DashboardPage = lazyPage(() => import('../features/dashboard/DashboardPage'));
const ProjectsPage = lazyPage(() => import('../features/projects/ProjectsPage'));
const ProjectLayout = lazyPage(() => import('../features/projects/ProjectLayout'));
const ProjectOverview = lazyPage(() => import('../features/projects/ProjectOverview'));
const ProjectTasksPage = lazyPage(() => import('../features/projects/ProjectTasksPage'));
const ProjectActivityPage = lazyPage(() => import('../features/projects/ProjectActivityPage'));
const MilestonePage = lazyPage(() => import('../features/projects/MilestonePage'));
const EpicPage = lazyPage(() => import('../features/projects/EpicPage'));
const ProjectBoardPage = lazyPage(() => import('../features/boards/ProjectBoardPage'));
const BoardsPage = lazyPage(() => import('../features/boards/BoardsPage'));
const BoardPage = lazyPage(() => import('../features/boards/BoardPage'));
const TaskPage = lazyPage(() => import('../features/tasks/TaskPage'));
const ActivityPage = lazyPage(() => import('../features/timeline/ActivityPage'));
const WorklogPage = lazyPage(() => import('../features/timeline/WorklogPage'));
const SpaceSettingsLayout = lazyPage(() => import('../features/settings/SpaceSettingsLayout'));
const SpaceGeneralSettings = lazyPage(() => import('../features/settings/SpaceGeneralSettings'));
const MembersSettings = lazyPage(() => import('../features/settings/MembersSettings'));
const InvitationsSettings = lazyPage(() => import('../features/settings/InvitationsSettings'));
const StatusSettings = lazyPage(() => import('../features/settings/StatusSettings'));
const TagSettings = lazyPage(() => import('../features/settings/TagSettings'));
const DataSettings = lazyPage(() => import('../features/settings/DataSettings'));
const SpaceDangerSettings = lazyPage(() => import('../features/settings/SpaceDangerSettings'));
const NotFoundPage = lazyPage(() => import('../features/common/NotFoundPage'));

// Before the router reads the address: the token of a link (/invite#t=…) leaves the address bar.
takeLinkTokenFromAddress();

// Routes (design §12.2).
const router = createBrowserRouter([
  {
    // Signed-out pages: a signed-in browser goes to the app.
    element: <PublicOnly />,
    errorElement: <RouteError variant="full" />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/setup', element: <SetupPage /> },
      { path: '/signup', element: <SignupPage /> },
      { path: '/forgot', element: <ForgotPasswordPage /> },
    ],
  },
  {
    // The pages a link opens, signed in or out.
    element: <PublicPage />,
    errorElement: <RouteError variant="full" />,
    children: [
      { path: '/signup/complete', element: <SignupCompletePage /> },
      { path: '/reset', element: <ResetPasswordPage /> },
      { path: '/email/confirm', element: <EmailConfirmPage /> },
      { path: '/recover', element: <RecoverPage /> },
      { path: '/invite', element: <InvitePage /> },
    ],
  },
  {
    element: <AuthedApp />,
    errorElement: <RouteError variant="full" />,
    children: [
      { index: true, element: <HomeRedirect /> },
      // Old bookmarks and links in descriptions and comments: the same page in a space.
      ...LEGACY_SPACE_ROUTES.map((path) => ({ path, element: <LegacySpaceRedirect /> })),
      {
        path: 's/:spaceId',
        // Errors in the shell itself (sidebar, gates) replace the whole screen…
        element: <SpaceLayout />,
        children: [
          {
            // …while a page that fails keeps the shell (sidebar, bottom bar) around its error.
            errorElement: <RouteError />,
            children: [
              { index: true, element: <SpaceHome /> },
              { path: 'dashboard', element: <DashboardPage /> },
              { path: 'projects', element: <ProjectsPage /> },
              {
                path: 'projects/:projectId',
                element: <ProjectLayout />,
                children: [
                  { index: true, element: <ProjectOverview /> },
                  { path: 'board', element: <ProjectBoardPage /> },
                  { path: 'tasks', element: <ProjectTasksPage /> },
                  { path: 'activity', element: <ProjectActivityPage /> },
                  { path: 'milestones/:milestoneId', element: <MilestonePage /> },
                  { path: 'epics/:epicId', element: <EpicPage /> },
                ],
              },
              { path: 'boards', element: <BoardsPage /> },
              { path: 'boards/:boardId', element: <BoardPage /> },
              { path: 'tasks/:taskKey', element: <TaskPage /> },
              { path: 'activity', element: <ActivityPage /> },
              { path: 'worklog', element: <WorklogPage /> },
              {
                path: 'settings',
                element: <SpaceSettingsLayout />,
                children: [
                  { index: true, element: <SpaceGeneralSettings /> },
                  { path: 'members', element: <MembersSettings /> },
                  { path: 'invitations', element: <InvitationsSettings /> },
                  { path: 'statuses', element: <StatusSettings /> },
                  { path: 'tags', element: <TagSettings /> },
                  { path: 'data', element: <DataSettings /> },
                  { path: 'danger', element: <SpaceDangerSettings /> },
                ],
              },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
      {
        // The pages outside any space.
        element: <DirectoryLayout />,
        children: [
          {
            errorElement: <RouteError />,
            children: [
              { path: 'spaces', element: <SpacesPage /> },
              { path: 'spaces/import', element: <ImportPage /> },
              {
                path: 'settings',
                element: <AccountSettingsLayout />,
                children: [
                  { index: true, element: <AccountSettings /> },
                  { path: 'security', element: <SecuritySettings /> },
                  { path: 'preferences', element: <PreferencesSettings /> },
                  { path: 'danger', element: <AccountDangerSettings /> },
                ],
              },
              {
                path: 'admin',
                element: <AdminLayout />,
                children: [
                  { index: true, element: <AdminOverview /> },
                  { path: 'settings', element: <AdminSettings /> },
                  { path: 'users', element: <AdminUsers /> },
                  { path: 'users/:userId', element: <AdminUserDetail /> },
                  { path: 'invitations', element: <AdminInvitations /> },
                  { path: 'spaces', element: <AdminSpaces /> },
                ],
              },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
