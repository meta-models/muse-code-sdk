"""Build ordinary static wire modules from source entries."""
from pathlib import Path
import runpy

from setuptools import setup
from setuptools.command.build_py import build_py


class StaticBuildPy(build_py):
    def run(self) -> None:
        super().run()
        if self.editable_mode:
            return  # The editable path exposes source-time assembly.
        source = Path(self.get_package_dir("muse_code_msp"))
        loader = source / "_entry_loader.py"
        if loader.is_file():
            # build_py already copied fixed assets; the shared source assembler
            # supplies declarations and removes build-only loader inputs.
            runpy.run_path(str(loader))["write_static_modules"](
                source, Path(self.build_lib) / "muse_code_msp"
            )


setup(cmdclass={"build_py": StaticBuildPy})
