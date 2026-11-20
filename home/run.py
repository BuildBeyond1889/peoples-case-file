#!/usr/bin/env python3
"""Weekly home run: update the code, collect SEC public companies, publish to the repo's sec-data branch.

    python home/run.py              full run, then publish
    python home/run.py --limit 25   quick test, publishes too (marked test_run in meta.json)
    python home/run.py --no-publish collect only

Data stays out of the main branch: sec-data is a single-commit branch replaced every run.
The daily site build (build.yml) copies it into site/sec/.
"""
import configparser, os, shutil, subprocess, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REMOTE = 'https://github.com/BuildBeyond1889/peoples-case-file.git'


def git(*a, cwd=REPO, check=True):
    print('> git', ' '.join(a), flush=True)
    return subprocess.run(['git', *a], cwd=cwd, check=check)


def main():
    args = sys.argv[1:]
    git('pull', '--ff-only', check=False)
    r = subprocess.run([sys.executable, os.path.join(REPO, 'home', 'sec_national.py'), *[a for a in args if a != '--no-publish']])
    if r.returncode:
        sys.exit('Collector stopped with an error - see the log in the data folder. Nothing was published.')
    if '--no-publish' in args:
        return
    cp = configparser.ConfigParser()
    cp.read_string('[s]\n' + open(os.path.join(os.path.dirname(REPO), 'private', 'settings.ini'), encoding='utf-8-sig').read())
    pub = os.path.join(cp['s'].get('data_dir') or os.path.join(os.path.dirname(REPO), 'data'), 'publish')
    if not os.path.isdir(os.path.join(pub, '.git')):
        git('init', '-q', cwd=pub)
        git('remote', 'add', 'origin', REMOTE, cwd=pub)
    # commit as the public handle only, never the PC owner's name
    git('config', 'user.name', 'BuildBeyond1889', cwd=pub)
    git('config', 'user.email', 'BuildBeyond1889@users.noreply.github.com', cwd=pub)
    git('config', 'core.autocrlf', 'false', cwd=pub)
    open(os.path.join(pub, 'README.md'), 'w').write('Data branch: SEC public-company records built by home/sec_national.py. Replaced every run. Code lives on main.\n')
    if subprocess.run(['git', 'rev-parse', '--verify', '-q', 'HEAD'], cwd=pub, capture_output=True).returncode == 0:
        git('checkout', '-q', '--orphan', 'next', cwd=pub)
    git('add', '-A', cwd=pub)
    git('commit', '-q', '-m', 'SEC public companies (home run)', cwd=pub)
    git('branch', '-M', 'sec-data', cwd=pub)
    git('push', '-f', 'origin', 'sec-data', cwd=pub)
    git('gc', '--prune=now', '-q', cwd=pub, check=False)
    print('\nPublished. The site picks it up at the next daily build (09:17 UTC), or run the build by hand on GitHub.')


if __name__ == '__main__':
    main()
