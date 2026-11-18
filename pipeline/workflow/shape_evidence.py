"""Index actual recipe/source/shape hashes; never pretend this is tool UI proof."""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

try:
    from . import agent_assets
except ImportError:
    import agent_assets


def generate(concept):
    root = Path(concept).resolve()
    recipe_path = root / 'release-recipe.json'
    recipe = agent_assets.load(recipe_path)
    out = agent_assets._control_path(root, 'release')
    shapes = [row for row in recipe['layers'] if row['type'] == 'shape']
    records = []
    for row in shapes:
        if row.get('copyright_category') != 'original':
            raise ValueError('Programmatic shapes must be classified original')
        source = agent_assets.safe_path(root, 'release/assets/' + row['id'] + '.png')
        agent_assets._image(source)
        records.append(dict(id=row['id'], name=row['name'], recipe=row, path=str(source.relative_to(root)), sha256=agent_assets.digest(source)))
    renderer = Path(__file__).with_name('assemble.py')
    report = dict(schema_version=1, origin='programmatic', tool='workflow.assemble',
                  recipe=dict(path='release-recipe.json', sha256=agent_assets.digest(recipe_path)),
                  source_code=dict(path='pipeline/workflow/assemble.py', sha256=agent_assets.digest(renderer)),
                  assets=records,
                  notice='Generated recipe/hash index, not an execution receipt or platform-required screenshot. Retain actual source code, recipe and tool evidence separately.')
    agent_assets.atomic_json(out / 'shape-provenance.json', report)
    lines = ['PROGRAMMATIC SHAPE INDEX - NOT A TOOL SCREENSHOT',
             'Recipe SHA256: ' + report['recipe']['sha256'],
             'Renderer SHA256: ' + report['source_code']['sha256'],
             'Original recipe/source and assets are required to reproduce and verify.']
    lines.extend(row['id'] + ' SHA256: ' + row['sha256'] for row in records)
    image = Image.new('RGB', (1400, 50 + 30 * len(lines)), 'white')
    draw = ImageDraw.Draw(image)
    for i, line in enumerate(lines):
        draw.text((20, 20 + 30 * i), line.encode('ascii', 'backslashreplace').decode('ascii'), font=ImageFont.load_default(), fill='black')
    image.save(out / 'shape-evidence.png')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('concept', type=Path)
    generate(parser.parse_args().concept)


if __name__ == '__main__':
    main()
