# Complete Examples

Working examples to adapt. All assume the default prefix (`/custom`).

## 1. Team page with colocated partials

Full-width page (`sidebar={false}`), catalog data + a reusable partial.

```astro
---
// pages/_components/TeamMember.astro
interface Props {
  name: string;
  role?: string;
}
const { name, role = 'Engineer' } = Astro.props;
---

<div class="rounded-lg border border-[rgb(var(--ec-page-border))] bg-[rgb(var(--ec-card-bg))] p-4">
  <p class="font-semibold text-[rgb(var(--ec-page-text))]">{name}</p>
  <p class="text-sm text-[rgb(var(--ec-page-text-muted))]">{role}</p>
</div>
```

```astro
---
// pages/team.astro → /custom/team
import Layout from '@catalog/layouts/Layout.astro';
import TeamMember from './_components/TeamMember.astro';
import { getTeams, getUsers } from '@catalog/utils';

const teams = await getTeams();
const users = await getUsers();
---

<Layout title="Our Team" description="The people behind our architecture" sidebar={false}>
  <div class="mx-auto max-w-5xl px-8 py-12">
    <h1 class="text-3xl font-bold text-[rgb(var(--ec-page-text))]">Our Team</h1>
    <p class="mt-2 text-[rgb(var(--ec-page-text-muted))]">
      {teams.length} teams · {users.length} people
    </p>

    {teams.map((team) => (
      <section class="mt-10">
        <h2 class="text-xl font-semibold text-[rgb(var(--ec-page-text))]">{team.data.name}</h2>
        <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(team.data.members ?? []).map((member) => (
            <TeamMember name={member.data?.name ?? member.id} role={member.data?.role} />
          ))}
        </div>
      </section>
    ))}
  </div>
</Layout>
```

## 2. Fetching external data + shared nav partial + dynamic child pages

A section (`/custom/github`, `/custom/github/:repo`) that fetches from an external API and shares a nav between parent and children.

```astro
---
// pages/_components/GithubNav.astro — shared nav with active state
export const repos = ['eventcatalog', 'generator-asyncapi', 'generator-openapi'];
const currentPath = Astro.url.pathname.replace(/\/$/, '');
const links = [
  { href: '/custom/github', label: 'Overview' },
  ...repos.map((repo) => ({ href: `/custom/github/${repo}`, label: repo })),
];
---

<nav class="flex gap-2 border-b border-[rgb(var(--ec-page-border))] pb-3">
  {links.map(({ href, label }) => (
    <a
      href={href}
      class={`rounded-full px-3 py-1 text-sm ${
        currentPath === href
          ? 'bg-[rgb(var(--ec-accent))] text-[rgb(var(--ec-accent-text))]'
          : 'text-[rgb(var(--ec-page-text-muted))] hover:text-[rgb(var(--ec-page-text))]'
      }`}
    >
      {label}
    </a>
  ))}
</nav>
```

```astro
---
// pages/github.astro → /custom/github
import Layout from '@catalog/layouts/Layout.astro';
import GithubNav, { repos } from './_components/GithubNav.astro';

const stats = await Promise.all(
  repos.map(async (repo) => {
    const res = await fetch(`https://api.github.com/repos/event-catalog/${repo}`);
    const data = await res.json();
    return { repo, stars: data.stargazers_count ?? 0, issues: data.open_issues_count ?? 0 };
  })
);
---

<Layout title="GitHub Insights" sidebar={false}>
  <div class="mx-auto max-w-4xl px-8 py-10">
    <GithubNav />
    <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
      {stats.map(({ repo, stars, issues }) => (
        <a href={`/custom/github/${repo}`} class="rounded-lg border border-[rgb(var(--ec-page-border))] bg-[rgb(var(--ec-card-bg))] p-4">
          <p class="font-semibold text-[rgb(var(--ec-page-text))]">{repo}</p>
          <p class="text-sm text-[rgb(var(--ec-page-text-muted))]">★ {stars} · {issues} open issues</p>
        </a>
      ))}
    </div>
  </div>
</Layout>
```

```astro
---
// pages/github/[repo].astro → /custom/github/:repo
import Layout from '@catalog/layouts/Layout.astro';
import GithubNav, { repos } from '../_components/GithubNav.astro';

// In static output mode, dynamic pages need getStaticPaths instead:
// export const getStaticPaths = () => repos.map((repo) => ({ params: { repo } }));

const { repo } = Astro.params;
if (!repos.includes(repo!)) {
  return new Response(null, { status: 404 });
}

const res = await fetch(`https://api.github.com/repos/event-catalog/${repo}`);
const data = await res.json();
---

<Layout title={`GitHub — ${repo}`} sidebar={false}>
  <div class="mx-auto max-w-4xl px-8 py-10">
    <GithubNav />
    <h1 class="mt-6 text-2xl font-bold text-[rgb(var(--ec-page-text))]">{data.full_name}</h1>
    <p class="mt-2 text-[rgb(var(--ec-page-text-muted))]">{data.description}</p>
  </div>
</Layout>
```

## 3. Catalog dashboard from collection data

```astro
---
// pages/architecture.astro → /custom/architecture
import Layout from '@catalog/layouts/Layout.astro';
import { getDomains, getServices, getEvents, getCommands, getQueries } from '@catalog/utils';

const [domains, services, events, commands, queries] = await Promise.all([
  getDomains({ getAllVersions: false }),
  getServices({ getAllVersions: false }),
  getEvents({ getAllVersions: false }),
  getCommands({ getAllVersions: false }),
  getQueries({ getAllVersions: false }),
]);

const cards = [
  { label: 'Domains', count: domains.length, href: '/architecture/domains' },
  { label: 'Services', count: services.length, href: '/architecture/services' },
  { label: 'Events', count: events.length, href: '/architecture/messages' },
  { label: 'Commands', count: commands.length, href: '/architecture/messages' },
  { label: 'Queries', count: queries.length, href: '/architecture/messages' },
];
---

<Layout title="Architecture Overview">
  <div class="px-8 py-10">
    <h1 class="text-2xl font-bold text-[rgb(var(--ec-page-text))]">Architecture at a glance</h1>
    <div class="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
      {cards.map(({ label, count, href }) => (
        <a href={href} class="rounded-lg border border-[rgb(var(--ec-page-border))] bg-[rgb(var(--ec-card-bg))] p-4 text-center">
          <p class="text-3xl font-bold text-[rgb(var(--ec-accent))]">{count}</p>
          <p class="text-sm text-[rgb(var(--ec-page-text-muted))]">{label}</p>
        </a>
      ))}
    </div>

    <h2 class="mt-10 text-lg font-semibold text-[rgb(var(--ec-page-text))]">Latest services</h2>
    <ul class="mt-3 space-y-2">
      {services.map((service) => (
        <li>
          <a class="text-[rgb(var(--ec-accent))]" href={`/docs/services/${service.data.id}/${service.data.version}`}>
            {service.data.name}
          </a>
          <span class="text-sm text-[rgb(var(--ec-page-text-muted))]"> — v{service.data.version} · {service.data.summary}</span>
        </li>
      ))}
    </ul>
  </div>
</Layout>
```

## 4. Custom homepage

`pages/homepage.astro` replaces the catalog landing page at `/` (it is NOT served under the prefix).

```astro
---
// pages/homepage.astro → /
import Layout from '@catalog/layouts/Layout.astro';
import { getDomains } from '@catalog/utils';

const domains = await getDomains({ getAllVersions: false });
---

<Layout title="Acme Architecture Hub" sidebar={false}>
  <div class="mx-auto max-w-3xl px-8 py-16 text-center">
    <h1 class="text-4xl font-bold text-[rgb(var(--ec-page-text))]">Acme Architecture Hub</h1>
    <p class="mt-4 text-lg text-[rgb(var(--ec-page-text-muted))]">
      Explore our {domains.length} business domains, the services that power them, and the messages that connect them.
    </p>
    <div class="mt-8 flex justify-center gap-4">
      <a href="/architecture/domains" class="rounded-md bg-[rgb(var(--ec-accent))] px-5 py-2 text-[rgb(var(--ec-accent-text))]">Explore domains</a>
      <a href="/docs" class="rounded-md border border-[rgb(var(--ec-page-border))] px-5 py-2 text-[rgb(var(--ec-page-text))]">Read the docs</a>
    </div>
  </div>
</Layout>
```

## 5. API endpoints

See [api-routes.md](api-routes.md) for endpoint examples (`pages/api/stats.ts`, `pages/api/teams/[id].ts`) and the `output: "server"` requirement.
